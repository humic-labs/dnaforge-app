import { describe, expect, it, vi } from 'vitest';
import { fitCanvasLabel } from '../canvas-drawing';

function createMeasureContext(charWidth = 10) {
  const measureText = vi.fn((text: string) => ({ width: text.length * charWidth }));
  return {
    ctx: { measureText } as unknown as CanvasRenderingContext2D,
    measureText,
  };
}

describe('fitCanvasLabel', () => {
  it('keeps fitting labels unchanged', () => {
    const { ctx, measureText } = createMeasureContext();

    expect(fitCanvasLabel(ctx, 'short', 100)).toBe('short');
    expect(measureText).toHaveBeenCalledTimes(1);
  });

  it('truncates labels with logarithmic canvas measurements', () => {
    const { ctx, measureText } = createMeasureContext();
    const label = 'A'.repeat(200);

    expect(fitCanvasLabel(ctx, label, 100)).toBe(`${'A'.repeat(9)}\u2026`);
    expect(measureText.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('returns null when even an ellipsis cannot fit', () => {
    const { ctx } = createMeasureContext();

    expect(fitCanvasLabel(ctx, 'label', 5)).toBeNull();
  });
});
