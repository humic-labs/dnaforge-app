import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';
import * as drawing from './overlays/indexed-cds-zoom-drawing';
import type { Feature, Genome, RenderState } from '../../types';
import { installMeasureTextCanvasContext } from './cds-parity-test-internals';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

beforeAll(() => {
  installMeasureTextCanvasContext();
});

describe('indexed transcript coding-shape parity', () => {
  it.each(['forward', 'reverse'] as const)(
    'morphs the %s coding exons instead of keeping the cached transcript blocks',
    async (direction) => {
      const feature: Feature = {
        id: 7,
        type: 'mRNA',
        start: 100,
        end: 900,
        direction,
        displayName: 'spliced transcript',
        color: 0x3b82f6,
        lane: 0,
        exons: [
          { start: 101, end: 400 },
          { start: 601, end: 900 },
        ],
        cds: [
          { start: 121, end: 400 },
          { start: 601, end: 880 },
        ],
        compositeKind: 'transcript',
      };
      const genome: Genome = {
        name: 'indexed transcript morph',
        length: 12000,
        sequence: 'GCT'.repeat(4000),
        circular: false,
        features: [feature],
      };
      const state: RenderState = {
        morph: 0,
        viewOffset: 0,
        zoom: 6,
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
      const draw = vi.spyOn(drawing, 'drawIndexedCdsZoomGlyph');
      try {
        renderer.render(state);
        expect(renderer.getCurrentPathMapper()?.pixelsPerBp).toBeCloseTo(0.4, 8);
        expect(draw.mock.calls.some((call) => call[2].id === feature.id)).toBe(true);
        expect(draw.mock.results.some((result) => result.value === true)).toBe(true);
      } finally {
        renderer.destroy();
        draw.mockRestore();
      }
    }
  );
});
