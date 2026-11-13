import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';
import type { Feature, Genome, RenderState } from '../../types';
import { cdsRendererInternals, installMeasureTextCanvasContext } from './cds-parity-test-internals';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

beforeAll(() => {
  installMeasureTextCanvasContext();
});

describe('indexed coding zoom parity', () => {
  it.each([0.2, 0.27, 0.32, 0.35, 0.4, 0.8, 3, 7])(
    'uses the regular coding band at %s pixels per base',
    async (pixelsPerBp) => {
      const feature: Feature = {
        id: 1,
        type: 'CDS',
        start: 0,
        end: 999,
        direction: 'forward',
        displayName: 'coding feature',
        color: 0x3b82f6,
        lane: 0,
        cdsLane: 0,
      };
      const genome: Genome = {
        name: 'indexed coding zoom',
        length: 12000,
        sequence: 'GCT'.repeat(4000),
        circular: false,
        features: [feature],
      };
      const state: RenderState = {
        morph: 0,
        viewOffset: 0,
        zoom: (genome.length * pixelsPerBp) / 800,
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
      try {
        const codons = vi.spyOn(cdsRendererInternals(renderer).codonTrack, 'renderCodons');
        renderer.render(state);
        const path = renderer.getCurrentPathMapper();
        expect(path).not.toBeNull();
        const pose = cdsReplacementZoomPresentation(pixelsPerBp, 800);
        expect(path?.pixelsPerBp).toBeCloseTo(pixelsPerBp, 8);
        expect(path?.cdsChevronHeight).toBeCloseTo(pose.aaHeight, 8);
        if (pose.progress > 0) {
          expect(codons).toHaveBeenCalled();
          expect(codons.mock.calls[0][6]).toBeCloseTo(pose.colorAlpha, 8);
        }
      } finally {
        renderer.destroy();
      }
    }
  );
});
