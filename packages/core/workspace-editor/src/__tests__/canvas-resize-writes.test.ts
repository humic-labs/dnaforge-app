// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { syncViewportCanvasSizes } from '../canvas-viewport-sizing';

describe('canvas backing writes during viewport resize', () => {
  const initial = {
    width: 420.5,
    viewportHeight: 588.5,
    totalHeight: 10000,
    dpr: 1.75,
    mainCanvasTransferred: false,
  };

  function prepared() {
    const mainCanvas = document.createElement('canvas');
    const selectionCanvas = document.createElement('canvas');
    const params = { ...initial, mainCanvas, selectionCanvas };
    syncViewportCanvasSizes(params);
    return { params, mainCanvas, selectionCanvas };
  }

  it.each([
    ['width', { width: 480.5 }, 'height'],
    ['height', { viewportHeight: 640.5 }, 'width'],
  ] as const)('writes only the changed %s backing dimension', (changed, patch, stable) => {
    const { params, mainCanvas, selectionCanvas } = prepared();
    const mainStable = vi.spyOn(mainCanvas, stable, 'set');
    const selectionStable = vi.spyOn(selectionCanvas, stable, 'set');
    const mainChanged = vi.spyOn(mainCanvas, changed, 'set');
    const selectionChanged = vi.spyOn(selectionCanvas, changed, 'set');

    const result = syncViewportCanvasSizes({ ...params, ...patch });

    expect(mainStable).not.toHaveBeenCalled();
    expect(selectionStable).not.toHaveBeenCalled();
    expect(mainChanged).toHaveBeenCalledExactlyOnceWith(
      changed === 'width' ? result.backingWidth : result.backingHeight
    );
    expect(selectionChanged).toHaveBeenCalledExactlyOnceWith(
      changed === 'width' ? result.backingWidth : result.backingHeight
    );
    expect(result.mainResized).toBe(true);
    expect(result.selectionResized).toBe(true);
  });

  it('does not rewrite stable or transferred backing surfaces', () => {
    const { params, mainCanvas, selectionCanvas } = prepared();
    const mainWidth = vi.spyOn(mainCanvas, 'width', 'set');
    const mainHeight = vi.spyOn(mainCanvas, 'height', 'set');
    const selectionWidth = vi.spyOn(selectionCanvas, 'width', 'set');
    const selectionHeight = vi.spyOn(selectionCanvas, 'height', 'set');

    expect(syncViewportCanvasSizes(params)).toMatchObject({
      mainResized: false,
      selectionResized: false,
    });
    expect(mainWidth).not.toHaveBeenCalled();
    expect(mainHeight).not.toHaveBeenCalled();
    expect(selectionWidth).not.toHaveBeenCalled();
    expect(selectionHeight).not.toHaveBeenCalled();

    const result = syncViewportCanvasSizes({
      ...params,
      width: 480.5,
      mainCanvasTransferred: true,
    });
    expect(result).toMatchObject({ mainResized: false, selectionResized: true });
    expect(mainWidth).not.toHaveBeenCalled();
    expect(mainHeight).not.toHaveBeenCalled();
    expect(selectionWidth).toHaveBeenCalledExactlyOnceWith(result.backingWidth);
    expect(selectionHeight).not.toHaveBeenCalled();
  });
});
