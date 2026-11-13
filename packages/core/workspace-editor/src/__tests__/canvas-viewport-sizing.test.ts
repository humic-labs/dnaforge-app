// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  shouldSyncViewportCanvasSizesDuringScroll,
  syncViewportCanvasSizes,
  viewportCanvasHeight,
} from '../canvas-viewport-sizing';

describe('canvas viewport sizing', () => {
  it('keeps canvas CSS height synchronized with viewport height plus draw buffer', () => {
    expect(viewportCanvasHeight(592, 3_208_228)).toBe(692);
    expect(viewportCanvasHeight(0, 3_208_228)).toBe(3_208_228);
  });

  it('defers main-thread canvas resizing until the draw frame', () => {
    expect(shouldSyncViewportCanvasSizesDuringScroll('worker')).toBe(true);
    expect(shouldSyncViewportCanvasSizesDuringScroll('main')).toBe(false);
    expect(shouldSyncViewportCanvasSizesDuringScroll('initializing')).toBe(false);
  });

  it('resizes the selection overlay during worker-backed viewport resize', () => {
    const mainCanvas = document.createElement('canvas');
    const selectionCanvas = document.createElement('canvas');
    mainCanvas.width = 2595;
    mainCanvas.height = 1144;
    selectionCanvas.width = 2595;
    selectionCanvas.height = 1144;

    const result = syncViewportCanvasSizes({
      mainCanvas,
      selectionCanvas,
      width: 1300,
      viewportHeight: 592,
      totalHeight: 3_208_228,
      dpr: 2,
      mainCanvasTransferred: true,
    });

    expect(mainCanvas.width).toBe(2595);
    expect(mainCanvas.height).toBe(1144);
    expect(mainCanvas.style.width).toBe('1300px');
    expect(mainCanvas.style.height).toBe('692px');
    expect(selectionCanvas.width).toBe(2600);
    expect(selectionCanvas.height).toBe(1384);
    expect(selectionCanvas.style.width).toBe('1300px');
    expect(selectionCanvas.style.height).toBe('692px');
    expect(result.selectionResized).toBe(true);
  });

  it('resizes both canvases when the main canvas has not been transferred', () => {
    const mainCanvas = document.createElement('canvas');
    const selectionCanvas = document.createElement('canvas');

    const result = syncViewportCanvasSizes({
      mainCanvas,
      selectionCanvas,
      width: 1300,
      viewportHeight: 472,
      totalHeight: 3_208_228,
      dpr: 2,
      mainCanvasTransferred: false,
    });

    expect(mainCanvas.width).toBe(2600);
    expect(mainCanvas.height).toBe(1144);
    expect(selectionCanvas.width).toBe(2600);
    expect(selectionCanvas.height).toBe(1144);
    expect(result.mainResized).toBe(true);
    expect(result.selectionResized).toBe(true);
  });

  it('keeps a fractional-DPR backing surface intact across repeated draws', () => {
    const mainCanvas = document.createElement('canvas');
    const selectionCanvas = document.createElement('canvas');
    const params = {
      mainCanvas,
      selectionCanvas,
      width: 776.3,
      viewportHeight: 687.4,
      totalHeight: 3_208_228,
      dpr: 1.75,
      mainCanvasTransferred: false,
    };
    const first = syncViewportCanvasSizes(params);
    const second = syncViewportCanvasSizes(params);

    expect(first.backingWidth).toBe(1359);
    expect(first.backingHeight).toBe(1378);
    expect(first.mainResized).toBe(true);
    expect(first.selectionResized).toBe(true);
    expect(second.mainResized).toBe(false);
    expect(second.selectionResized).toBe(false);
  });
});
