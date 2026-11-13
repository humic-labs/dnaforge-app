import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';
import { createBaseReader } from './shared/base-reader';
import type { Genome, RenderState } from '../../types';
import { installMeasureTextCanvasContext } from './cds-parity-test-internals';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

beforeAll(() => {
  installMeasureTextCanvasContext();
});

describe('indexed sequence-window readiness', () => {
  it('does not reveal replacement codons for an empty accepted window', async () => {
    const genome: Genome = {
      name: 'empty lazy sequence window',
      length: 12000,
      sequenceAvailable: true,
      sequenceWindow: { startBp: 0, bases: '' },
      circular: false,
      features: [
        {
          id: 1,
          type: 'CDS',
          start: 0,
          end: 999,
          direction: 'forward',
          displayName: 'pending coding bases',
          color: 0x3b82f6,
          lane: 0,
          cdsLane: 0,
        },
      ],
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
    try {
      expect(createBaseReader(genome.sequence, genome.sequenceWindow)).toBeNull();
      renderer.render(state);
      const path = renderer.getCurrentPathMapper();
      expect(path?.pixelsPerBp).toBeCloseTo(3, 8);
      expect(path?.sequenceVisible).toBe(false);
    } finally {
      renderer.destroy();
    }
  });
});
