import { describe, expect, it, vi } from 'vitest';
import {
  createReadHoverSurface,
  readHoverCrop,
  readHoverLayoutScale,
  READ_HOVER_FILTERS,
  READ_SELECTION_FILTERS,
} from './read-hover-surface';

const bounds = { left: 32, top: 16, width: 256, height: 160 };
const read = { left: 83.296875, top: 82.6875, width: 26.546875, height: 2.390625 };

describe('read hover', () => {
  it('uses the actual device scale when the browser snaps fractional layout edges', () => {
    const css = { inlineSize: 708, blockSize: 550.5 };
    const pixels = { inlineSize: 708, blockSize: 551 };
    const canvas = { left: 268, top: 126.25, width: 708, height: 550.5 };
    expect(readHoverLayoutScale(canvas, css, pixels, 1)).toBe(1);
    expect(
      readHoverLayoutScale({ ...canvas, top: 126.5 }, css, { ...pixels, blockSize: 550 }, 1)
    ).toBe(1);
    expect(readHoverLayoutScale(canvas, css, { ...pixels, blockSize: 549 }, 1)).toBe(0);
  });

  it('retains a measured physical layout scale for an emulated viewport', () => {
    const css = { inlineSize: 256, blockSize: 160 };
    expect(readHoverLayoutScale(bounds, css, { inlineSize: 512, blockSize: 320 }, 1.25)).toBe(2);
  });

  it('captures a small aligned patch for a fractional read', () => {
    const crop = readHoverCrop({ width: 320, height: 200 }, bounds, read, 2);
    expect(crop).toEqual({
      x: 4,
      y: 3,
      w: 33.125,
      h: 3.125,
      clipW: 34,
      clipH: 4,
      left: 100,
      top: 100,
      width: 40,
      height: 10,
      scale: 1.25,
      presentedWidth: 320,
      presentedHeight: 200,
    });
  });

  it('clips the last device pixel when the painted border exceeds its layer', () => {
    const crop = readHoverCrop(
      { width: 512, height: 320 },
      bounds,
      { left: 24.953125, top: 12.078125, width: 108.765625, height: 5.140625 },
      2
    );
    expect(crop).toMatchObject({ left: 50, top: 24, w: 218, h: 10, clipW: 217, clipH: 10 });
  });

  it('reads only visible pixels when the read extends beyond the map', () => {
    expect(
      readHoverCrop(
        { width: 256, height: 160 },
        bounds,
        { left: -10.796875, top: 155.25, width: 29.1875, height: 8.625 },
        2
      )
    ).toMatchObject({ left: 0, top: 155, width: 18, height: 5, x: -11 });
    expect(
      readHoverCrop({ width: 256, height: 160 }, bounds, { ...read, left: 270 }, 2)
    ).toBeNull();
  });

  it('keeps the native tint for subpixel map placement or an unavailable backing surface', () => {
    const backing = { width: 320, height: 200 };
    expect(readHoverCrop(backing, { ...bounds, left: 31.375 }, read, 2)).toBeNull();
    expect(readHoverCrop({ ...backing, width: 0 }, bounds, read, 2)).toBeNull();
    expect(readHoverCrop(backing, bounds, { ...read, width: Number.NaN }, 2)).toBeNull();
  });

  it.each([
    { top: 126.25, presentedHeight: 551, patchTop: 274 },
    { top: 126.5, presentedHeight: 550, patchTop: 273 },
    { top: 126.75, presentedHeight: 550, patchTop: 273 },
  ])(
    'uses the snapped canvas height at a CSS origin of $top',
    ({ top, presentedHeight, patchTop }) => {
      const crop = readHoverCrop(
        { width: 708, height: 551 },
        { left: 268, top, width: 708, height: 550.5 },
        { left: 339.296875, top: 273.4375, width: 26.546875, height: 2.390625 },
        1,
        1
      );
      expect(crop).toMatchObject({ top: patchTop, presentedHeight, presentedWidth: 708, scale: 1 });
    }
  );

  it('preserves the native filter for a texture resize beyond edge rounding', () => {
    expect(
      readHoverCrop({ width: 256, height: 160 }, { ...bounds, height: 158 }, read, 1, 1)
    ).toBeNull();
  });

  it('declines a browser without the requested color surface', () => {
    const getContext = vi.fn().mockReturnValue(null);
    const document = { createElement: () => ({ getContext }) } as unknown as Document;
    expect(
      createReadHoverSurface({ document, colorSpace: 'display-p3', layoutScale: 2 })
    ).toBeNull();
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('keeps the original tint for hover and selection in both themes', () => {
    expect(READ_HOVER_FILTERS).toEqual({
      light: 'brightness(0.82) saturate(2)',
      dark: 'brightness(1.18)',
    });
    expect(READ_SELECTION_FILTERS).toEqual({
      light: READ_HOVER_FILTERS.light,
      dark: 'brightness(1.1)',
    });
  });
});
