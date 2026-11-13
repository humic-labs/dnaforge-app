import { describe, expect, it, vi } from 'vitest';
import { CDS_GLYPH_STYLE } from '@waypoint/platform';
import type { Feature, Genome, RenderState } from '../../../types';
import { getStadiumDimensions } from '../../../geometry/stadium';
import { LinearPathMapper, StadiumPathMapper } from '../shared/path-mapper';
import * as geometry from './annotation-feature-geometry';
import { drawCDSLabelStrip } from './indexed-annotation-draw-cds';
import { IndexedAnnotationOverlay } from './annotation-overlay';

vi.mock('../shared/label-pill', async (original) => ({
  ...(await original<typeof import('../shared/label-pill')>()),
  measurePillLabelTextWidth: (text: string) => text.length * 6,
  drawLanePillLabelText: () => undefined,
}));

const feature: Feature = {
  id: 1,
  type: 'CDS',
  start: 10,
  end: 100,
  direction: 'none',
  displayName: 'CDS',
  color: 0x3b82f6,
  lane: 0,
};

const genome: Genome = {
  name: 'connector-parity',
  length: 1000,
  circular: false,
  sequence: 'A'.repeat(1000),
  features: [feature],
};

function state(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function path(kind: 'linear' | 'stadium') {
  const dims = getStadiumDimensions(800, 400, 0, 80);
  return kind === 'linear'
    ? new LinearPathMapper({
        viewportWidth: 800,
        viewportHeight: 400,
        bpPerPixel: 0.25,
        viewStartBp: 0,
        viewEndBp: 200,
        annotationLanes: 1,
        translationLanes: 1,
        hasSequence: true,
      })
    : new StadiumPathMapper({
        genomeLength: 1000,
        viewOffset: 0,
        zoom: 1,
        dims,
        ox: 80,
        oy: 80,
        stagePosX: 0,
        stagePosY: 0,
        bpPerPixel: 1000 / dims.totalLength,
        hasSequence: true,
        viewportWidth: 800,
        viewportHeight: 400,
      });
}

describe('indexed CDS connector parity', () => {
  it.each(['linear', 'stadium'] as const)(
    'joins the actual filled connector to the chevron edge in %s view',
    (kind) => {
      const overlay = new IndexedAnnotationOverlay();
      overlay.loadGenome(genome);
      const draw = overlay.getImmediateDrawControllerForTest();
      const filled = vi.spyOn(draw, 'drawLaneBandWithGaps').mockImplementation(() => undefined);
      vi.spyOn(draw, 'drawLabelTextInPill').mockImplementation(() => undefined);
      try {
        drawCDSLabelStrip(
          draw,
          draw.graphics,
          feature,
          100,
          90,
          feature.color,
          1,
          path(kind),
          state()
        );
        expect(filled).toHaveBeenCalledTimes(1);
        const [, , , , offset, halfHeight] = filled.mock.calls[0];
        expect(halfHeight * 2).toBe(CDS_GLYPH_STYLE.replacementTopEdgeHeight);
        expect(offset + halfHeight).toBeCloseTo(
          draw.featureOffset(feature) + draw.scaledBarHeight() / 2,
          8
        );
      } finally {
        overlay.destroy();
        vi.restoreAllMocks();
      }
    }
  );

  it.each(['linear', 'stadium'] as const)(
    'gives the %s outline the same connector placement as the filled body',
    (kind) => {
      const overlay = new IndexedAnnotationOverlay();
      overlay.loadGenome(genome);
      const draw = overlay.getImmediateDrawControllerForTest();
      const outline = vi.spyOn(geometry, 'cdsLabelStripOutlineCommand');
      try {
        draw.cdsLabelStripOutlineCommand(path(kind), 10, 32, 100, -14, 7, 2.25);
        expect(outline).toHaveBeenCalledTimes(1);
        expect(outline.mock.calls[0][8]).toBe(7 - 2.25);
      } finally {
        overlay.destroy();
        vi.restoreAllMocks();
      }
    }
  );
});
