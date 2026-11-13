import {
  SEQUENCE_FONT_FAMILY as NATIVE_SEQUENCE_FONT_FAMILY,
  SEQUENCE_LABEL_FONT_FAMILY,
  SEQUENCE_SELECTION_FILL,
} from '@waypoint/platform';

export const ANNOTATION_BAR_HEIGHT = 14;
export const ANNOTATION_LANE_SPACING = 2;
export const ANNOTATION_LANE_TOTAL = ANNOTATION_BAR_HEIGHT + ANNOTATION_LANE_SPACING;
export const RULER_HEIGHT = 30;

export const ARROW_MAX_WIDTH = 8;
export const ARROW_HEIGHT_RATIO = 0.6;

export const LABEL_FONT_FAMILY = SEQUENCE_LABEL_FONT_FAMILY;
export const LABEL_FONT_SIZE = 10;
export const LABEL_FONT_WEIGHT = '500';
export const LABEL_LETTER_SPACING = 0;
export const SEQUENCE_FONT_FAMILY = NATIVE_SEQUENCE_FONT_FAMILY;
export const CUT_SITE_LABEL_FONT_FAMILY = NATIVE_SEQUENCE_FONT_FAMILY;
export const SEQUENCE_FONT_SIZE = 11;
export const RULER_FONT_SIZE = 9;

export const TEXT_COLOR = 0x222222;
export const TEXT_COLOR_MUTED = 0x888888;
export const RULER_COLOR = 0x555555;
export const RULER_LINE_COLOR = 0x999999;
export const BACKBONE_COLOR = 0x4a9eff;
export const SELECTION_STROKE_COLOR = 0x333333;
export const CANVAS2D_SELECTION_FILL_COLOR = SEQUENCE_SELECTION_FILL.light.color;
export const CANVAS2D_SELECTION_FILL_ALPHA = SEQUENCE_SELECTION_FILL.light.alpha;

export type WebGLThemeMode = 'light' | 'dark';

export interface WebGLRenderTheme {
  mode: WebGLThemeMode;
  background: number;
  sequenceBackground: number;
  text: number;
  textMuted: number;
  rulerText: number;
  rulerLine: number;
  selectionFill: number;
  selectionFillAlpha: number;
  selectionStroke: number;
  viewportRange: number;
  digestFocusMask: number;
  digestFocusMaskAlpha: number;
}

const LIGHT_WEBGL_THEME: WebGLRenderTheme = {
  mode: 'light',
  background: 0xffffff,
  sequenceBackground: 0xffffff,
  text: TEXT_COLOR,
  textMuted: TEXT_COLOR_MUTED,
  rulerText: RULER_COLOR,
  rulerLine: RULER_LINE_COLOR,
  selectionFill: CANVAS2D_SELECTION_FILL_COLOR,
  selectionFillAlpha: CANVAS2D_SELECTION_FILL_ALPHA,
  selectionStroke: 0x000000,
  viewportRange: 0x000000,
  digestFocusMask: 0xffffff,
  digestFocusMaskAlpha: 0.62,
};

const DARK_WEBGL_THEME: WebGLRenderTheme = {
  mode: 'dark',
  background: 0x1e1c1a,
  sequenceBackground: 0x292725,
  text: 0xeee8dd,
  textMuted: 0xa79f93,
  rulerText: 0xb0a79c,
  rulerLine: 0x5a5248,
  selectionFill: SEQUENCE_SELECTION_FILL.dark.color,
  selectionFillAlpha: SEQUENCE_SELECTION_FILL.dark.alpha,
  selectionStroke: 0xf5e58a,
  viewportRange: 0xeee8dd,
  digestFocusMask: 0x1e1c1a,
  digestFocusMaskAlpha: 0.58,
};

export function webglThemeForMode(mode: WebGLThemeMode | undefined): WebGLRenderTheme {
  return mode === 'dark' ? DARK_WEBGL_THEME : LIGHT_WEBGL_THEME;
}

export function webglThemeColorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function colorToRgb(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  let hue = 0;
  let saturation = 0;
  const lightness = (max + min) / 2;

  if (max !== min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === red) {
      hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
    } else if (max === green) {
      hue = ((blue - red) / delta + 2) / 6;
    } else {
      hue = ((red - green) / delta + 4) / 6;
    }
  }

  return [hue * 360, saturation * 100, lightness * 100];
}

function hslToColor(h: number, s: number, l: number): number {
  const saturation = clampPercent(s) / 100;
  const lightness = clampPercent(l) / 100;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    const color = lightness - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)));
  };

  return (channel(0) << 16) | (channel(8) << 8) | channel(4);
}

export const DARK_ANNOTATION_LIGHTNESS_SCALE = 0.72;

export function webglAnnotationColorForMode(
  color: number,
  mode: WebGLThemeMode | undefined
): number {
  if (mode !== 'dark') return color;

  const [r, g, b] = colorToRgb(color);
  const [hue, saturation, lightness] = rgbToHsl(r, g, b);
  const adjustedLightness = (24 + (lightness / 100) * 18) * DARK_ANNOTATION_LIGHTNESS_SCALE;
  const adjustedSaturation = saturation < 5 ? saturation : saturation * 0.58;
  return hslToColor(hue, adjustedSaturation, adjustedLightness);
}

export function isLightColor(hexColor: number): boolean {
  const r = (hexColor >> 16) & 0xff;
  const g = (hexColor >> 8) & 0xff;
  const b = hexColor & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

export function contrastTextColor(bgColor: number): number {
  return isLightColor(bgColor) ? TEXT_COLOR : 0xffffff;
}
