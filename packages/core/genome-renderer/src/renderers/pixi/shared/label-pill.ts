import { Text, TextStyle } from 'pixi.js';
import type { PathMapper } from './path-mapper';
import type { RenderState } from '../../../types';
import { CurvedLabelRenderer, getMeasureCtx, renderCurvedLabelOnPath } from './curved-label';
import { advanceBpByScreenWidth } from './lane-path';
import { LABEL_FONT_FAMILY, LABEL_FONT_SIZE, LABEL_FONT_WEIGHT, isLightColor } from './theme';

export const PILL_LABEL_FONT_SIZE = LABEL_FONT_SIZE;
export const PILL_LABEL_PADDING = 6;
export const PILL_LABEL_ALPHA = 0.85;

const styleCache = new Map<string, TextStyle>();
const STYLE_CACHE_MAX_ENTRIES = 64;

export const PILL_LABEL_TEXT_DARK_THEME = 0xd1d5db;
let darkThemePillText = false;

export function setPillLabelTheme(themeMode: RenderState['themeMode']): void {
  darkThemePillText = themeMode === 'dark';
}

export function pillLabelTextColor(bgColor: number): number {
  if (isLightColor(bgColor)) return 0x888888;
  return darkThemePillText ? PILL_LABEL_TEXT_DARK_THEME : 0xffffff;
}

export function targetPillLabelTextResolution(): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.max(2, dpr);
}

export const PILL_LABEL_EMPHASIS_STROKE_PX = 0.5;

export function pillLabelTextStyle(
  bgColor: number,
  fontSize = PILL_LABEL_FONT_SIZE,
  textColorOverride?: number,
  emphasized = false
): TextStyle {
  const roundedSize = Math.round(fontSize * 2) / 2;
  const textColor = textColorOverride ?? pillLabelTextColor(bgColor);
  const key = `${roundedSize}:${textColor}:${emphasized ? 'emphasis' : 'plain'}`;
  let style = styleCache.get(key);
  if (style) {
    styleCache.delete(key);
    styleCache.set(key, style);
    return style;
  }
  style = new TextStyle({
    fontSize: roundedSize,
    fill: textColor,
    fontFamily: LABEL_FONT_FAMILY,
    fontWeight: LABEL_FONT_WEIGHT,
    ...(emphasized ? { stroke: { color: textColor, width: PILL_LABEL_EMPHASIS_STROKE_PX } } : {}),
  });
  styleCache.set(key, style);
  while (styleCache.size > STYLE_CACHE_MAX_ENTRIES) {
    const oldestKey = styleCache.keys().next().value;
    if (oldestKey === undefined) break;
    styleCache.delete(oldestKey);
  }
  return style;
}

const LABEL_WIDTH_CACHE_MAX_ENTRIES = 8192;
const labelWidthCache = new Map<string, number>();
let labelWidthFontListenerInstalled = false;

export function measurePillLabelTextWidth(text: string, fontSize = PILL_LABEL_FONT_SIZE): number {
  if (!labelWidthFontListenerInstalled && typeof document !== 'undefined') {
    labelWidthFontListenerInstalled = true;
    document.fonts?.addEventListener?.('loadingdone', () => labelWidthCache.clear());
  }
  const key = `${fontSize}\u0000${text}`;
  const cached = labelWidthCache.get(key);
  if (cached !== undefined) return cached;
  const ctx = getMeasureCtx();
  if (!ctx) return text.length * fontSize * 0.6;
  ctx.font = `${LABEL_FONT_WEIGHT} ${fontSize}px ${LABEL_FONT_FAMILY}`;
  const width = ctx.measureText(text).width;
  labelWidthCache.set(key, width);
  while (labelWidthCache.size > LABEL_WIDTH_CACHE_MAX_ENTRIES) {
    const oldestKey = labelWidthCache.keys().next().value;
    if (oldestKey === undefined) break;
    labelWidthCache.delete(oldestKey);
  }
  return width;
}

export function truncatePillLabel(
  text: string,
  maxWidth: number,
  fontSize = PILL_LABEL_FONT_SIZE
): string | null {
  if (maxWidth <= 0) return null;
  if (measurePillLabelTextWidth(text, fontSize) <= maxWidth) return text;
  if (maxWidth < fontSize * 0.5) return null;

  let candidate = text;
  while (candidate.length > 1 && measurePillLabelTextWidth(`${candidate}…`, fontSize) > maxWidth) {
    candidate = candidate.slice(0, -1);
  }
  return candidate.length > 0 ? `${candidate}…` : null;
}

export interface DrawLanePillLabelTextOptions {
  text: string;
  path: PathMapper;
  startBp: number;
  widthPx: number;
  offsetPx: number;
  color: number;
  maxTextWidth: number;
  acquireText: () => Text;
  curvedLabels: CurvedLabelRenderer;
  alpha?: number;
  fontSize?: number;
  textColor?: number;
  centerBpOverride?: number | null;
  curvedRangeStartBp?: number | null;
  curvedRangeEndBp?: number | null;
}

export function drawLanePillLabelText(options: DrawLanePillLabelTextOptions): string | null {
  const {
    text,
    path,
    startBp,
    widthPx,
    offsetPx,
    color,
    maxTextWidth,
    acquireText,
    curvedLabels,
    alpha = 1,
    fontSize = PILL_LABEL_FONT_SIZE,
    textColor,
    centerBpOverride = null,
    curvedRangeStartBp = null,
    curvedRangeEndBp = null,
  } = options;

  const displayText = truncatePillLabel(text, maxTextWidth, fontSize);
  if (!displayText) return null;

  const centerBp = centerBpOverride ?? advanceBpByScreenWidth(path, startBp, widthPx / 2, offsetPx);

  if (path.isArcMode) {
    const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offsetPx);
    renderCurvedLabelOnPath(
      curvedLabels,
      displayText,
      path,
      centerBp,
      measurePillLabelTextWidth(displayText, fontSize),
      offsetPx,
      curvedRangeStartBp ?? startBp,
      curvedRangeEndBp ?? endBp,
      fontSize,
      textColor ?? pillLabelTextColor(color),
      1,
      alpha
    );
    return displayText;
  }

  const center = path.featureLabelPosAt(centerBp, offsetPx);
  const textObj = acquireText();
  textObj.text = displayText;
  const targetStyle = pillLabelTextStyle(color, fontSize, textColor);
  if (textObj.style !== targetStyle) textObj.style = targetStyle;
  textObj.alpha = alpha;
  const resolution = targetPillLabelTextResolution();
  if (textObj.resolution !== resolution) textObj.resolution = resolution;
  textObj.roundPixels = true;
  textObj.anchor.set(0.5, 0.5);
  textObj.x = center.x;
  textObj.y = center.y;
  textObj.rotation = 0;
  textObj.scale.set(1);

  return displayText;
}
