// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import { CDS_GLYPH_STYLE } from '@waypoint/platform';
import { PixiLinearRenderer } from './linear-renderer';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';
import { PixiStadiumRenderer } from './stadium-renderer';
import type { Feature, Genome, RenderState } from '../../types';
import { cdsRendererInternals, installMeasureTextCanvasContext } from './cds-parity-test-internals';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

beforeAll(() => {
  installMeasureTextCanvasContext();
});

const renderers = [
  ['ordinary linear', () => new PixiLinearRenderer()],
  ['indexed alignment', () => new IndexedPixiLinearRenderer()],
  ['stadium/circular', () => new PixiStadiumRenderer()],
] as const;

describe('non-wrapped CDS carrier row placement', () => {
  for (const [name, create] of renderers) {
    it.each(['forward', 'reverse'] as const)(
      `${name}: CDS segment metadata keeps %s amino acids below the label`,
      async (direction) => {
        const renderer = create();
        const feature: Feature = {
          id: 1,
          type: 'CDS',
          start: 0,
          end: 999,
          direction,
          displayName: 'CDS',
          color: 0x3b82f6,
          lane: 0,
          cdsLane: 0,
          cds: [{ start: 1, end: 999 }],
        };
        const genome: Genome = {
          name: 'CDS carrier row',
          length: 1000,
          sequence: 'GCT'.repeat(333) + 'A',
          circular: name === 'stadium/circular',
          features: [feature],
        };
        const state: RenderState = {
          morph: 1,
          viewOffset: 0,
          zoom: 10,
          width: 800,
          height: 400,
          selectedIds: new Set(),
          hoveredId: null,
          viewportRange: null,
          highlightRange: null,
          cursorPosition: null,
          hoveredCutSiteId: null,
          perfPanelVisible: false,
          sequencePresentation: { cdsSizing: 'canvas' },
        };
        await renderer.init(
          { stage: new Container(), canvas: document.createElement('canvas') } as Application,
          genome,
          () => state
        );
        try {
          const track = cdsRendererInternals(renderer).codonTrack;
          const draw = vi.spyOn(track, 'renderCodons');
          renderer.render(state);
          expect(draw).toHaveBeenCalled();
          const path = renderer.getCurrentPathMapper()!;
          const center = draw.mock.calls[0][3];
          const halfHeight = (path.cdsChevronHeight ?? path.rowHeight * 0.9) / 2;
          const labelCenter =
            cdsRendererInternals(renderer).annotationOverlay.getFeatureRenderOffset(feature)!;
          expect(center - halfHeight).toBeCloseTo(labelCenter + CDS_GLYPH_STYLE.labelHeight / 2, 8);
        } finally {
          renderer.destroy();
        }
      }
    );
  }
});
