import type { ImmediateDrawHost } from './indexed-annotation-draw-host';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import {
  renderImmediateFeature,
  shouldSplitLinearWrappedFeature,
} from './indexed-annotation-draw-immediate';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
    ...overrides,
  };
}

function host(overrides: Partial<ImmediateDrawHost> = {}): ImmediateDrawHost {
  return {
    genomeLength: 1000,
    genomeCircular: false,
    graphics: {} as never,
    hitCache: [],
    outlineCache: new Map(),
    lastDrawnFeatureCount: 0,
    lastImmediateDrawnLayerTypes: new Set(),
    lastImmediateTranscriptDrawnCount: 0,
    featureOffset: () => 0,
    scaledBarHeight: () => 8,
    setFeatureOutline() {},
    strokeDraftOutlineCommands() {},
    drawTranscriptGlyph() {},
    drawStandard() {},
    cdsDetailProgress: () => 0,
    featureLevelLabelCenterBp: () => 25,
    drawFeatureLevelTransitionShape() {},
    drawCDSLabelStrip() {},
    cdsTransitionHalfHeight: () => 1,
    ...overrides,
  };
}

describe('indexed immediate-draw presenter', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain(
      'Lanes are now always assigned at load time; the per-frame visibility'
    );
    expect(source).not.toContain('DNA-TG1: unified transcript glyph short-circuits the legacy');
    expect(source).not.toContain('function shouldSplitLinearWrappedFeature(');
    expect(source).not.toContain('function linearWrappedSplicedFeatureSegments(');
    expect(source).not.toContain('function renderImmediateFeature(');
  });

  it('skips wrapped circular split on a linear host', () => {
    expect(
      shouldSplitLinearWrappedFeature(host(), feature({ start: 900, end: 20 }), {
        isArcMode: false,
      } as never)
    ).toBe(false);
    expect(
      shouldSplitLinearWrappedFeature(
        host({ genomeCircular: true }),
        feature({ start: 900, end: 20 }),
        { isArcMode: false } as never
      )
    ).toBe(true);
  });

  it('skips subpixel features unless forced', () => {
    const path = {
      isArcMode: false,
      pixelsPerBp: 0.001,
      isFeatureVisible: () => true,
      featurePolygonAt: () => [0, 0, 1, 0, 1, 1, 0, 1],
    } as never;
    expect(
      renderImmediateFeature(
        host(),
        {} as never,
        feature(),
        path,
        { themeMode: 'dark' } as never,
        false
      )
    ).toBe('skipped-subpixel');
  });
});
