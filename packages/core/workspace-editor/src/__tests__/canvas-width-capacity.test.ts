import { describe, expect, it } from 'vitest';
import { viewportCanvasWidth } from '../canvas-viewport-sizing';

describe('wrapped canvas width capacity', () => {
  it('reuses the backing width across neighboring viewport widths without cropping', () => {
    const widths = [400, 401, 420.5, 450, 480, 500];
    const capacities = widths.map((width) => viewportCanvasWidth(width, width, true));
    expect(new Set(capacities).size).toBe(1);
    for (const [index, width] of widths.entries()) {
      expect(capacities[index]).toBeGreaterThanOrEqual(width + 128);
      expect(capacities[index] - width).toBeLessThan(256);
    }
  });

  it('grows before the viewport reaches its retained capacity and preserves wider content', () => {
    const before = viewportCanvasWidth(511.5, 511.5, true);
    const after = viewportCanvasWidth(512.5, 512.5, true);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(640.5);
    expect(viewportCanvasWidth(420, 1000, true)).toBe(1000);
  });

  it('retains exact fixed-column content width', () => {
    expect(viewportCanvasWidth(420.5, 390.25, false)).toBe(390.25);
    expect(viewportCanvasWidth(420.5, 1000.25, false)).toBe(1000.25);
  });
});
