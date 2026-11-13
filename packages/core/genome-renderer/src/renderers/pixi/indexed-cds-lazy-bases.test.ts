import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';
import * as drawing from './overlays/indexed-cds-zoom-drawing';
import type { Feature, Genome, RenderState } from '../../types';
import { cdsRendererInternals, installMeasureTextCanvasContext } from './cds-parity-test-internals';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

beforeAll(() => {
  installMeasureTextCanvasContext();
});

describe('indexed coding body while lazy bases are pending', () => {
  it('retains the coding body until its replacement codons can paint', async () => {
    const feature: Feature = {
      id: 1,
      type: 'CDS',
      start: 0,
      end: 999,
      direction: 'forward',
      displayName: 'pending coding bases',
      color: 0x3b82f6,
      lane: 0,
      cdsLane: 0,
    };
    const genome: Genome = {
      name: 'lazy indexed sequence',
      length: 12000,
      sequenceAvailable: true,
      circular: false,
      features: [feature],
    };
    const state: RenderState = {
      morph: 0,
      viewOffset: 0,
      zoom: 45,
      width: 800,
      height: 400,
      selectedIds: new Set(),
      hoveredId: null,
      highlightRange: null,
      cursorPosition: null,
      hoveredCutSiteId: null,
      perfPanelVisible: false,
    };
    const renderer = new IndexedPixiLinearRenderer();
    await renderer.init(
      { stage: new Container(), canvas: document.createElement('canvas') } as Application,
      genome,
      () => state
    );
    const fillHeights: number[] = [];
    const originalDraw = drawing.drawIndexedCdsZoomGlyph;
    const draw = vi.spyOn(drawing, 'drawIndexedCdsZoomGlyph').mockImplementation((...args) => {
      const sink = args[1];
      const originalFill = sink.fillPoly.bind(sink);
      args[1] = {
        ...sink,
        fillPoly: (points, color, alpha) => {
          const ys = points.filter((_value, index) => index % 2 === 1);
          if (alpha > 0) fillHeights.push(Math.max(...ys) - Math.min(...ys));
          originalFill(points, color, alpha);
        },
        strokePoly: sink.strokePoly.bind(sink),
      };
      return originalDraw(...args);
    });
    const codons = vi.spyOn(cdsRendererInternals(renderer).codonTrack, 'renderCodons');
    try {
      renderer.render(state);
      const path = renderer.getCurrentPathMapper();
      expect(path?.pixelsPerBp).toBeCloseTo(3, 8);
      expect(path?.sequenceVisible).toBe(false);
      expect(codons).not.toHaveBeenCalled();
      expect({
        fillHeights,
        bandHeight: path?.cdsZoomPresentation?.aaHeight,
        colorAlpha: path?.cdsZoomPresentation?.colorAlpha,
        hasBody: fillHeights.some((height) => height >= (path?.cdsZoomPresentation?.aaHeight ?? 0)),
      }).toMatchObject({ hasBody: true });
    } finally {
      draw.mockRestore();
      codons.mockRestore();
      renderer.destroy();
    }
  });
});
