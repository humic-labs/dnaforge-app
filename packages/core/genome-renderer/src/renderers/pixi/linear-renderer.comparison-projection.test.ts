import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container, type Graphics } from 'pixi.js';
import { attachPixiInteractionAdapter } from '../../react/interaction-adapter';
import { comparisonFixture } from '../../test-support/comparison-projection-fixture';
import { comparisonPlot, type ComparisonHit } from '../../comparison-projection';
import type { Genome, RenderState } from '../../types';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';
import { PixiLinearRenderer } from './linear-renderer';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((id: string) =>
    id !== '2d'
      ? null
      : {
          font: '',
          fillStyle: '',
          textBaseline: '',
          scale: () => undefined,
          measureText: (text: string) => ({ width: text.length * 6 }),
          fillText: () => undefined,
          clearRect: () => undefined,
        }) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => document.body.replaceChildren());

const projection = comparisonFixture();

async function fixture(Renderer: typeof PixiLinearRenderer = PixiLinearRenderer) {
  const renderer = new Renderer();
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 510,
    bottom: 320,
    width: 500,
    height: 300,
    toJSON: () => ({}),
  });
  Object.defineProperty(document, 'elementFromPoint', { value: () => canvas, configurable: true });
  const state: RenderState = {
    comparisonProjection: projection,
    selectedComparison: null,
    morph: 0,
    viewOffset: 0.2,
    zoom: 3,
    width: 1000,
    height: 600,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
  const genome: Genome = {
    name: 'NC_000913.3',
    length: 4_641_652,
    sequence: '',
    circular: false,
    features: [],
  };
  const stage = new Container();
  await renderer.init(
    { stage, canvas, renderer: {} } as unknown as Application,
    genome,
    () => state
  );
  return { renderer, canvas, state, stage, genome };
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number) {
  canvas.dispatchEvent(
    new MouseEvent(type, { clientX: 10 + x / 2, clientY: 20 + y / 2, button: 0, bubbles: true })
  );
}

describe('gapped comparison in the existing native renderers', () => {
  for (const Renderer of [PixiLinearRenderer, IndexedPixiLinearRenderer]) {
    it(`paints both references, exact gap runs and reverse blocks through ${Renderer.name}`, async () => {
      const f = await fixture(Renderer);
      try {
        f.state.comparisonCamera = { projectionId: projection.id, startColumn: 0, endColumn: 9 };
        expect(f.renderer.render(f.state)).toBe(false);
        expect(f.renderer.getComparisonProjectionDiagnostics()).toMatchObject({
          visible: true,
          sourceBlockCount: 2,
          blocksPainted: 1,
          gapsPainted: 2,
          baseLetters: 18,
          gapSamples: [
            { side: 'target', startColumn: 2, endColumn: 4, boundary: 2 },
            { side: 'query', startColumn: 6, endColumn: 7, boundary: 6 },
          ],
        });
        const plot = comparisonPlot(f.state.width, f.state.height);
        expect(
          f.renderer.hitTestComparison(plot.x + (plot.width * 2.5) / 9, plot.targetY, f.state)
        ).toMatchObject({
          side: 'target',
          target: { kind: 'gap', boundary: 2 },
          query: { kind: 'base', position: 2 },
        });
        expect(f.state.zoom).toBe(3);
        expect(f.state.viewOffset).toBe(0.2);
        f.state.comparisonProjection = null;
        f.renderer.render(f.state);
        expect(f.renderer.getComparisonProjectionDiagnostics()).toBeNull();
        expect(Reflect.get(f.renderer, 'scrollingLayer').visible).toBe(true);
      } finally {
        f.renderer.destroy();
      }
    });
  }

  it('routes native hover, selection, pan, zoom and Escape to exact comparison loci', async () => {
    const f = await fixture();
    const hover = vi.fn(),
      click = vi.fn(),
      camera = vi.fn(),
      sequenceSelection = vi.fn();
    const interaction = attachPixiInteractionAdapter({
      canvasEl: f.canvas,
      renderer: f.renderer,
      stateRef: { current: f.state },
      activeGenome: f.genome,
      optionsRef: {
        current: {
          genome: f.genome,
          circular: false,
          width: 1000,
          height: 600,
          comparisonProjection: projection,
          onComparisonHover: hover,
          onComparisonClick: click,
          onComparisonCameraChange: camera,
          onSelectionChange: sequenceSelection,
        },
      },
      circular: false,
    });
    try {
      f.renderer.setComparisonCamera(
        { projectionId: projection.id, startColumn: 0, endColumn: 9 },
        f.state
      );
      const plot = comparisonPlot(1000, 600),
        x = plot.x + (plot.width * 2.5) / 9;
      pointer(f.canvas, 'pointermove', x, plot.targetY);
      interaction.flushInteraction();
      expect(hover).toHaveBeenLastCalledWith(
        expect.objectContaining({ target: { kind: 'gap', referenceId: 'target', boundary: 2 } })
      );
      pointer(f.canvas, 'pointerdown', x, plot.targetY);
      pointer(f.canvas, 'pointerup', x, plot.targetY);
      expect((click.mock.lastCall?.[0] as ComparisonHit).target.kind).toBe('gap');
      expect(sequenceSelection).not.toHaveBeenCalled();
      expect(f.state.highlightRange).toBeNull();
      f.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: 10 + x / 2,
          clientY: 20 + plot.targetY / 2,
          deltaY: -50,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      const zoomed = f.renderer.getComparisonCamera(f.state)!;
      expect(zoomed.endColumn - zoomed.startColumn).toBeLessThan(9);
      f.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: 200,
          clientY: 100,
          deltaY: 20,
          bubbles: true,
          cancelable: true,
        })
      );
      expect(f.renderer.getComparisonCamera(f.state)!.startColumn).toBeGreaterThan(
        zoomed.startColumn
      );
      expect(camera).toHaveBeenCalledWith(
        expect.objectContaining({ projectionId: projection.id }),
        'zoom'
      );
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(f.state.selectedComparison).toBeNull();
      expect(click).toHaveBeenLastCalledWith(null);
      expect(f.state.zoom).toBe(3);
      expect(f.state.viewOffset).toBe(0.2);
    } finally {
      interaction.cleanup();
      f.renderer.destroy();
    }
  });

  it('cancels a pointer gesture when its comparison is replaced', async () => {
    const f = await fixture(),
      click = vi.fn(),
      selection = vi.fn();
    const interaction = attachPixiInteractionAdapter({
      canvasEl: f.canvas,
      renderer: f.renderer,
      stateRef: { current: f.state },
      activeGenome: f.genome,
      optionsRef: {
        current: {
          genome: f.genome,
          circular: false,
          width: 1000,
          height: 600,
          comparisonProjection: projection,
          onComparisonClick: click,
          onSelectionChange: selection,
        },
      },
      circular: false,
    });
    try {
      const plot = comparisonPlot(1000, 600);
      pointer(f.canvas, 'pointerdown', plot.x + 10, plot.targetY);
      f.state.comparisonProjection = { ...projection, id: 'new-comparison' };
      pointer(f.canvas, 'pointerup', plot.x + 10, plot.targetY);
      expect(click).not.toHaveBeenCalled();
      expect(selection).not.toHaveBeenCalled();
      expect(f.state.selectedComparison).toBeNull();
    } finally {
      interaction.cleanup();
      f.renderer.destroy();
    }
  });
});
