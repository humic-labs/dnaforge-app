import { CanvasTextMetrics, DOMAdapter, fontStringFromTextStyle, type TextStyle } from 'pixi.js';

let context: CanvasRenderingContext2D | null = null;
const anchors = new Map<string, number>();

export function canvasMiddleTextAnchorY(style: TextStyle): number {
  const font = fontStringFromTextStyle(style);
  const resolution = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const key = `${font}|${style.lineHeight}|${resolution}`;
  const cached = anchors.get(key);
  if (cached !== undefined) return cached;
  context ??= DOMAdapter.get().createCanvas(1, 1).getContext('2d') as CanvasRenderingContext2D;
  const metrics = CanvasTextMetrics.measureFont(font);
  const height =
    Math.ceil(Math.ceil(Math.max(1, style.lineHeight, metrics.fontSize)) * resolution) / resolution;
  if (!context || !(height > 0)) return 0.5;
  context.font = font;
  context.textBaseline = 'alphabetic';
  const alphabetic = context.measureText('M').actualBoundingBoxAscent;
  context.textBaseline = 'middle';
  const middle = context.measureText('M').actualBoundingBoxAscent;
  if (!Number.isFinite(alphabetic) || !Number.isFinite(middle)) return 0.5;
  const lineShift = Math.max(0, (style.lineHeight - metrics.fontSize) / 2);
  const anchor = (metrics.ascent + lineShift - (alphabetic - middle)) / height;
  anchors.set(key, anchor);
  if (anchors.size > 64) anchors.delete(anchors.keys().next().value!);
  return anchor;
}
