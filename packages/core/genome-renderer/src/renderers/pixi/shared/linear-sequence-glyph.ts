import {
  CanvasTextMetrics,
  Container,
  DOMAdapter,
  Text,
  TextStyle,
  fontStringFromTextStyle,
} from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { IUPAC_COMPLEMENT } from '@waypoint/sequence-utils';

import { SEQUENCE_FONT_FAMILY } from './theme';

export const LINEAR_SEQUENCE_GLYPH_CONTRACT = 'reference-sequence-text-v1' as const;
export const LINEAR_SEQUENCE_GLYPH_RASTER_SIZE = 16;
export const LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL = 0xffffff;

export interface LinearSequenceGlyphVerticalMetrics {
  readonly top: number;
  readonly bottom: number;
  readonly strikeY: number;
}

const verticalMetricsCache = new Map<string, LinearSequenceGlyphVerticalMetrics>();

export function linearSequenceGlyphVerticalMetrics(
  style: TextStyle
): LinearSequenceGlyphVerticalMetrics | null {
  const font = fontStringFromTextStyle(style);
  const resolution = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const key = `${font}|${style.lineHeight}|${resolution}`;
  const cached = verticalMetricsCache.get(key);
  if (cached) return cached;
  const context = DOMAdapter.get().createCanvas(1, 1).getContext('2d');
  if (!context) return null;
  context.font = font;
  context.textBaseline = 'alphabetic';
  const fontMetrics = CanvasTextMetrics.measureFont(font);
  const height =
    Math.ceil(Math.ceil(Math.max(style.lineHeight, fontMetrics.fontSize)) * resolution) /
    resolution;
  const baseline =
    fontMetrics.ascent + Math.max(0, (style.lineHeight - fontMetrics.fontSize) / 2) - height / 2;
  const letters = Object.keys(IUPAC_COMPLEMENT)
    .filter((character) => /^[a-z]$/.test(character))
    .join('');
  const ink = context.measureText(letters);
  const body = context.measureText('a');
  const metrics = {
    top: baseline - ink.actualBoundingBoxAscent,
    bottom: baseline + ink.actualBoundingBoxDescent,
    strikeY: baseline + (body.actualBoundingBoxDescent - body.actualBoundingBoxAscent) / 2,
  };
  if (!Object.values(metrics).every(Number.isFinite)) return null;
  verticalMetricsCache.set(key, metrics);
  if (verticalMetricsCache.size > 8)
    verticalMetricsCache.delete(verticalMetricsCache.keys().next().value!);
  return metrics;
}

export interface LinearSequenceGlyphStyles {
  readonly primary: TextStyle;
  readonly muted: TextStyle;
}

export interface LinearSequenceGlyphConfiguration {
  readonly text: string;
  readonly style: TextStyle;
  readonly tint: number;
  readonly displayFontSize: number;
  readonly x: number;
  readonly y: number;
  readonly rotation?: number;
}

export function createLinearSequenceGlyphStyles(): LinearSequenceGlyphStyles {
  const neutral = new TextStyle({
    fontFamily: SEQUENCE_FONT_FAMILY,
    fontSize: LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
    lineHeight: LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
    fill: LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL,
  });
  return {
    primary: neutral,
    muted: neutral,
  };
}

export function createLinearSequenceGlyph(style: TextStyle, container: Container): Text {
  const glyph = new Text({ text: 'a', style });

  glyph.autoGarbageCollect = false;
  container.addChild(glyph);
  return glyph;
}

export function prepareLinearSequenceGlyphTextures(
  renderer: Renderer,
  glyphs: readonly Text[]
): void {
  for (const glyph of glyphs) {
    type CanvasTextBatchable = ReturnType<Renderer['renderPipes']['text']['initGpuText']>;
    const gpuState = glyph as Text & {
      readonly _gpuData: Record<number, CanvasTextBatchable | null | undefined>;
    };

    const batchable =
      gpuState._gpuData[renderer.uid] ?? renderer.renderPipes.text.initGpuText(glyph);
    const resolutionState = glyph as Text & {
      readonly _autoResolution: boolean;
      readonly _resolution: number | null;
    };
    const targetResolution = resolutionState._autoResolution
      ? renderer.resolution
      : resolutionState._resolution;
    if (
      batchable.currentKey === glyph.styleKey &&
      batchable.texture &&
      resolutionState._resolution === targetResolution
    ) {
      continue;
    }
    if (batchable.texture) {
      renderer.canvasText.decreaseReferenceCount(batchable.currentKey);
    }
    batchable.texture = renderer.canvasText.getManagedTexture(glyph);

    batchable.currentKey = glyph.styleKey;
  }
}

export function configureLinearSequenceGlyph(
  glyph: Text,
  configuration: LinearSequenceGlyphConfiguration
): void {
  const renderedText =
    configuration.text === '+' || configuration.text === '−'
      ? configuration.text
      : configuration.text.slice(0, 1).toLowerCase() || 'n';
  if (glyph.text !== renderedText) glyph.text = renderedText;
  if (glyph.style !== configuration.style) glyph.style = configuration.style;
  if (glyph.tint !== configuration.tint) glyph.tint = configuration.tint;
  const displayScale =
    configuration.displayFontSize / Math.max(1, LINEAR_SEQUENCE_GLYPH_RASTER_SIZE);
  if (glyph.scale.x !== displayScale || glyph.scale.y !== displayScale) {
    glyph.scale.set(displayScale);
  }
  if (glyph.anchor.x !== 0.5 || glyph.anchor.y !== 0.5) glyph.anchor.set(0.5, 0.5);
  if (glyph.x !== configuration.x) glyph.x = configuration.x;
  if (glyph.y !== configuration.y) glyph.y = configuration.y;
  const rotation = configuration.rotation ?? 0;
  if (glyph.rotation !== rotation) glyph.rotation = rotation;
  glyph.visible = true;
}
