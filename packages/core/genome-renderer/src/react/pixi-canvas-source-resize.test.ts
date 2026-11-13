// @vitest-environment jsdom

import { CanvasSource } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';

describe('CanvasSource backing resize ownership', () => {
  function sourceWithNativeCanvas() {
    const canvas = document.createElement('canvas');
    const source = new CanvasSource({
      resource: canvas,
      width: 420,
      height: 688,
      resolution: 1.75,
      autoDensity: true,
    });
    const widthSet = vi.spyOn(canvas, 'width', 'set');
    const heightSet = vi.spyOn(canvas, 'height', 'set');
    const events: string[] = [];
    const resized = vi.fn(() => events.push('resize'));
    const changed = vi.fn(() => events.push('change'));
    source.on('resize', resized);
    source.on('change', changed);
    return { source, canvas, widthSet, heightSet, events, resized, changed };
  }

  it.each([
    { dimension: 'width', width: 480.5, height: 688, pixels: 841 },
    { dimension: 'height', width: 420, height: 720.5, pixels: 1261 },
  ] as const)(
    'writes only the changed $dimension while preserving density and resize events',
    (next) => {
      const view = sourceWithNativeCanvas();
      try {
        expect(view.source.resize(next.width, next.height)).toBe(true);
        const changedSetter = next.dimension === 'width' ? view.widthSet : view.heightSet;
        const stableSetter = next.dimension === 'width' ? view.heightSet : view.widthSet;
        expect(changedSetter).toHaveBeenCalledExactlyOnceWith(next.pixels);
        expect(stableSetter).not.toHaveBeenCalled();
        expect(view.canvas.width).toBe(next.dimension === 'width' ? 841 : 735);
        expect(view.canvas.height).toBe(next.dimension === 'height' ? 1261 : 1204);
        expect(view.source.resolution).toBe(1.75);
        expect(Number.parseFloat(view.canvas.style.width)).toBeCloseTo(view.source.width, 8);
        expect(Number.parseFloat(view.canvas.style.height)).toBeCloseTo(view.source.height, 8);
        expect(view.source.width * view.source.resolution).toBeCloseTo(view.canvas.width, 8);
        expect(view.source.height * view.source.resolution).toBeCloseTo(view.canvas.height, 8);
        expect(view.events).toEqual(['resize', 'change']);
        expect(view.resized).toHaveBeenCalledExactlyOnceWith(view.source);
        expect(view.changed).toHaveBeenCalledExactlyOnceWith(view.source);
      } finally {
        view.source.destroy();
        view.widthSet.mockRestore();
        view.heightSet.mockRestore();
      }
    }
  );

  it('preserves both dimensions and CSS density when fractional resolution changes', () => {
    const view = sourceWithNativeCanvas();
    try {
      expect(view.source.resize(480.5, 720.5, 1.25)).toBe(true);
      expect(view.widthSet).toHaveBeenCalledExactlyOnceWith(601);
      expect(view.heightSet).toHaveBeenCalledExactlyOnceWith(901);
      expect(view.canvas.width).toBe(601);
      expect(view.canvas.height).toBe(901);
      expect(view.source.resolution).toBe(1.25);
      expect(view.source.width).toBeCloseTo(480.8, 8);
      expect(view.source.height).toBeCloseTo(720.8, 8);
      expect(Number.parseFloat(view.canvas.style.width)).toBeCloseTo(480.8, 8);
      expect(Number.parseFloat(view.canvas.style.height)).toBeCloseTo(720.8, 8);
      expect(view.events).toEqual(['resize', 'change']);
    } finally {
      view.source.destroy();
      view.widthSet.mockRestore();
      view.heightSet.mockRestore();
    }
  });

  it('leaves a stable backing surface and its resize events untouched', () => {
    const view = sourceWithNativeCanvas();
    try {
      expect(view.source.resize(420.02, 688.02, 1.75)).toBe(false);
      expect(view.widthSet).not.toHaveBeenCalled();
      expect(view.heightSet).not.toHaveBeenCalled();
      expect(view.canvas.width).toBe(735);
      expect(view.canvas.height).toBe(1204);
      expect(view.canvas.style.width).toBe('420px');
      expect(view.canvas.style.height).toBe('688px');
      expect(view.resized).not.toHaveBeenCalled();
      expect(view.changed).not.toHaveBeenCalled();
      expect(view.events).toEqual([]);
    } finally {
      view.source.destroy();
      view.widthSet.mockRestore();
      view.heightSet.mockRestore();
    }
  });
});
