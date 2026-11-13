// @vitest-environment jsdom

import { Container, Text } from 'pixi.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  LINEAR_SEQUENCE_GLYPH_CONTRACT,
  LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL,
  LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
  configureLinearSequenceGlyph,
  createLinearSequenceGlyph,
  createLinearSequenceGlyphStyles,
  prepareLinearSequenceGlyphTextures,
} from './linear-sequence-glyph';
import { SEQUENCE_FONT_FAMILY, webglThemeForMode } from './theme';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      scale: () => undefined,
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: () => undefined,
      clearRect: () => undefined,
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

describe('linear sequence glyph contract', () => {
  it('owns the exact reference-track typography and rasterization settings', () => {
    const styles = createLinearSequenceGlyphStyles();

    expect(LINEAR_SEQUENCE_GLYPH_CONTRACT).toBe('reference-sequence-text-v1');
    expect(LINEAR_SEQUENCE_GLYPH_RASTER_SIZE).toBe(16);
    expect(styles.primary.fontFamily).toBe(SEQUENCE_FONT_FAMILY);
    expect(styles.primary.fontSize).toBe(LINEAR_SEQUENCE_GLYPH_RASTER_SIZE);
    expect(styles.primary.lineHeight).toBe(LINEAR_SEQUENCE_GLYPH_RASTER_SIZE);
    expect(styles.primary.fill).toBe(LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL);
    expect(styles.muted).toBe(styles.primary);
  });

  it('normalizes, anchors, and scales every consumer through one shared primitive', () => {
    const container = new Container();
    const theme = webglThemeForMode('light');
    const styles = createLinearSequenceGlyphStyles();
    const glyph = createLinearSequenceGlyph(styles.primary, container);

    configureLinearSequenceGlyph(glyph, {
      text: 'T',
      style: styles.primary,
      tint: theme.text,
      displayFontSize: 11,
      x: 42,
      y: 17,
    });

    expect(glyph).toBeInstanceOf(Text);
    expect(glyph.parent).toBe(container);
    expect(glyph.text).toBe('t');
    expect(glyph.style).toBe(styles.primary);
    expect(glyph.tint).toBe(theme.text);
    expect(glyph.autoGarbageCollect).toBe(false);
    expect(glyph.anchor.x).toBe(0.5);
    expect(glyph.anchor.y).toBe(0.5);
    expect(glyph.scale.x).toBe(11 / LINEAR_SEQUENCE_GLYPH_RASTER_SIZE);
    expect(glyph.scale.y).toBe(11 / LINEAR_SEQUENCE_GLYPH_RASTER_SIZE);
    expect(glyph.position.x).toBe(42);
    expect(glyph.position.y).toBe(17);

    glyph.destroy();
    container.destroy();
  });

  it('defines readiness as a bound raster texture, not an empty Pixi batchable', () => {
    const container = new Container();
    const styles = createLinearSequenceGlyphStyles();
    const glyph = createLinearSequenceGlyph(styles.primary, container);
    const texture = { source: { uid: 1 } };
    const batchable = { currentKey: '--', texture: null as typeof texture | null };
    const initGpuText = vi.fn(() => batchable);
    const getManagedTexture = vi.fn((text: Text) => {
      (text as unknown as { _resolution: number })._resolution = 2;
      return texture;
    });
    const decreaseReferenceCount = vi.fn();
    const renderer = {
      resolution: 2,
      renderPipes: { text: { initGpuText } },
      canvasText: { getManagedTexture, decreaseReferenceCount },
    };

    prepareLinearSequenceGlyphTextures(renderer as never, [glyph]);

    expect(initGpuText).toHaveBeenCalledWith(glyph);
    expect(getManagedTexture).toHaveBeenCalledWith(glyph);
    expect(batchable.currentKey).toBe(glyph.styleKey);
    expect(batchable.texture).toBe(texture);

    prepareLinearSequenceGlyphTextures(renderer as never, [glyph]);
    expect(getManagedTexture).toHaveBeenCalledTimes(1);
    expect(decreaseReferenceCount).not.toHaveBeenCalled();

    glyph.destroy();
    container.destroy();
  });

  it('binds the managed texture under the resolution-resolved key Pixi will later release', () => {
    const container = new Container();
    const styles = createLinearSequenceGlyphStyles();
    const glyph = createLinearSequenceGlyph(styles.primary, container);
    const unresolvedKey = glyph.styleKey;
    const texture = { source: { uid: 2 } };
    const batchable = { currentKey: '--', texture: null as typeof texture | null };
    const getManagedTexture = vi.fn((text: Text) => {
      (text as unknown as { _resolution: number })._resolution = 2;
      return texture;
    });
    const renderer = {
      resolution: 2,
      renderPipes: { text: { initGpuText: vi.fn(() => batchable) } },
      canvasText: { getManagedTexture, decreaseReferenceCount: vi.fn() },
    };

    prepareLinearSequenceGlyphTextures(renderer as never, [glyph]);

    expect(glyph.styleKey).not.toBe(unresolvedKey);
    expect(batchable.currentKey).toBe(glyph.styleKey);
    expect(batchable.currentKey).not.toBe(unresolvedKey);
    expect(batchable.texture).toBe(texture);

    glyph.destroy();
    container.destroy();
  });

  it('reuses Pixi GPU bookkeeping when a pooled glyph changes letters', () => {
    const container = new Container();
    const styles = createLinearSequenceGlyphStyles();
    const glyph = createLinearSequenceGlyph(styles.primary, container);
    const rendererUid = 17;
    const textures = [{ source: { uid: 3 } }, { source: { uid: 4 } }];
    type TestBatchable = {
      currentKey: string;
      texture: (typeof textures)[number] | null;
      destroy: ReturnType<typeof vi.fn>;
    };
    const initGpuText = vi.fn((text: Text) => {
      const batchable: TestBatchable = { currentKey: '--', texture: null, destroy: vi.fn() };
      const gpuText = text as unknown as {
        _gpuData: Record<number, TestBatchable | null | undefined>;
      };
      gpuText._gpuData[rendererUid] = batchable;
      return batchable;
    });
    const getManagedTexture = vi.fn((text: Text) => {
      (text as unknown as { _resolution: number })._resolution = 2;
      return textures[getManagedTexture.mock.calls.length - 1];
    });
    const decreaseReferenceCount = vi.fn();
    const renderer = {
      uid: rendererUid,
      resolution: 2,
      renderPipes: { text: { initGpuText } },
      canvasText: { getManagedTexture, decreaseReferenceCount },
    };

    prepareLinearSequenceGlyphTextures(renderer as never, [glyph]);
    const firstKey = glyph.styleKey;
    glyph.text = 'c';
    prepareLinearSequenceGlyphTextures(renderer as never, [glyph]);

    expect(initGpuText).toHaveBeenCalledTimes(1);
    expect(decreaseReferenceCount).toHaveBeenCalledOnce();
    expect(decreaseReferenceCount).toHaveBeenCalledWith(firstKey);
    expect(getManagedTexture).toHaveBeenCalledTimes(2);
    const gpuText = glyph as unknown as {
      _gpuData: Record<number, TestBatchable | null | undefined>;
    };
    expect(gpuText._gpuData[rendererUid]?.currentKey).toBe(glyph.styleKey);
    expect(gpuText._gpuData[rendererUid]?.texture).toBe(textures[1]);

    glyph.destroy();
    container.destroy();
  });
});
