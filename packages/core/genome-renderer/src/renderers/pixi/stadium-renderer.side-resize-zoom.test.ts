// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { Application, Container } from 'pixi.js';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type { Feature, Genome, RenderState } from '../../types';
import { PixiStadiumRenderer } from './stadium-renderer';
import { MAX_SEQUENCE_PIXELS_PER_BP } from './shared/sequence-sizing';

beforeAll(() => {
  if (typeof CanvasRenderingContext2D === 'undefined') {
    (globalThis as unknown as { CanvasRenderingContext2D: unknown }).CanvasRenderingContext2D =
      class CanvasRenderingContext2D {};
  }
  HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
    contextId === '2d'
      ? { font: '', measureText: (text: string) => ({ width: text.length * 7 }) }
      : null) as typeof HTMLCanvasElement.prototype.getContext;
});

function puc19(): Genome {
  const source = parseGenBankFull(
    readFileSync(
      resolve(__dirname, '../../../../../../test-fixtures/sequences/circular/pUC19.gb'),
      'utf8'
    )
  );
  return {
    name: source.name,
    length: source.length,
    circular: true,
    sequence: source.sequence,
    features: source.annotations.map(
      (feature, id): Feature => ({
        id,
        type: feature.type,
        start: feature.start - 1,
        end: feature.end,
        displayName: feature.name,
        direction:
          feature.direction === 1 ? 'forward' : feature.direction === -1 ? 'reverse' : 'none',
        color: 0x3b82f6,
        lane: 0,
      })
    ),
  };
}

function sideBySideState(width: number): RenderState {
  return {
    morph: 1,
    viewOffset: 0.5,
    zoom: 1,
    width,
    height: 900,
    geometryHeight: 600,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

it('keeps a readable pUC19 camera zoom when the side-by-side map pane grows', async () => {
  const genome = puc19();
  const state = sideBySideState(419);
  const renderer = new PixiStadiumRenderer();
  await renderer.init(
    { stage: new Container(), canvas: document.createElement('canvas') } as unknown as Application,
    genome,
    () => state
  );
  try {
    const zoomBefore = renderer.getMaxZoom(state) * 0.4;
    state.zoom = zoomBefore;
    renderer.render(state);
    expect(state.zoom).toBeCloseTo(zoomBefore, 5);

    state.width = 518;
    renderer.render(state);

    expect(state.zoom).toBeCloseTo(zoomBefore, 5);
    expect(renderer.getCurrentPathMapper()?.pixelsPerBp).toBeLessThanOrEqual(
      MAX_SEQUENCE_PIXELS_PER_BP + 0.01
    );
  } finally {
    renderer.destroy();
  }
});
