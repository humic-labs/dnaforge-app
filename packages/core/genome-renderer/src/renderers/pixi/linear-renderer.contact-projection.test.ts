import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container, type Graphics } from 'pixi.js';
import { attachPixiInteractionAdapter } from '../../react/interaction-adapter';
import { contactPlotRect, type ContactProjection } from '../../contact-projection';
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

const projection: ContactProjection = {
  kind: 'contact-matrix',
  id: 'GSM2870426',
  xReference: { id: 'U00096.2', chrom: 'U00096.2', length: 4_639_675 },
  yReference: { id: 'U00096.2', chrom: 'U00096.2', length: 4_639_675 },
  cells: [
    { id: 'contact-0-0', start: 0, end: 100_000, targetStart: 0, targetEnd: 100_000, value: 25020 },
    {
      id: 'contact-46-46',
      start: 4_600_000,
      end: 4_639_675,
      targetStart: 4_600_000,
      targetEnd: 4_639_675,
      value: 5508,
    },
  ],
  colorScale: {
    kind: 'continuous',
    domain: [0, 25020],
    colors: ['#ffffff', '#ff0000'],
    missingColor: '#cccccc',
    transform: 'linear',
  },
};

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
    contactProjection: projection,
    selectedContact: null,
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

describe('native contact projection in existing sequence renderers', () => {
  for (const Renderer of [PixiLinearRenderer, IndexedPixiLinearRenderer]) {
    it(`paints and hits exact source intervals through ${Renderer.name}`, async () => {
      const f = await fixture(Renderer);
      try {
        expect(f.renderer.render(f.state)).toBe(false);
        const graphics = Reflect.get(f.renderer, 'contactGraphics') as Graphics;
        const fills = graphics.context.instructions.filter(
          (instruction) => instruction.action === 'fill'
        );
        expect(fills).toHaveLength(2);
        expect(fills[0].data.style.color).toBe(0xff0000);
        expect(f.renderer.getContactProjectionDiagnostics()).toMatchObject({
          projectionId: 'GSM2870426',
          sourceCellCount: 2,
          paintedCellCount: 2,
          visible: true,
          xReference: { id: 'U00096.2', length: 4_639_675 },
        });
        const plot = contactPlotRect(f.state.width, f.state.height);
        const hit = f.renderer.hitTestContact(
          plot.x + plot.width - 1,
          plot.y + plot.height - 1,
          f.state
        );
        expect(hit).toMatchObject({
          cellId: 'contact-46-46',
          value: 5508,
          x: { referenceId: 'U00096.2', start: 4_600_000, end: 4_639_675 },
          y: { referenceId: 'U00096.2', start: 4_600_000, end: 4_639_675 },
        });
        expect(f.state.zoom).toBe(3);
        expect(f.state.viewOffset).toBe(0.2);
        f.state.contactProjection = null;
        f.renderer.render(f.state);
        expect(Reflect.get(f.renderer, 'contactLayer').visible).toBe(false);
        expect(Reflect.get(f.renderer, 'scrollingLayer').visible).toBe(true);
      } finally {
        f.renderer.destroy();
      }
    });
  }

  it('routes native hover/click/zoom/pan into dual-axis state without a sequence selection', async () => {
    const f = await fixture();
    const hover = vi.fn();
    const click = vi.fn();
    const sequenceSelection = vi.fn();
    const invalidate = vi.fn();
    const cameraChange = vi.fn();
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
          contactProjection: projection,
          onContactHover: hover,
          onContactClick: click,
          onContactCameraChange: cameraChange,
          onSelectionChange: sequenceSelection,
        },
      },
      circular: false,
      invalidateRender: invalidate,
    });
    try {
      f.renderer.render(f.state);
      const plot = contactPlotRect(f.state.width, f.state.height);
      pointer(f.canvas, 'pointermove', plot.x + 1, plot.y + 1);
      interaction.flushInteraction();
      expect(hover).toHaveBeenLastCalledWith(
        expect.objectContaining({
          value: 25020,
          x: { referenceId: 'U00096.2', chrom: 'U00096.2', start: 0, end: 100_000 },
          y: { referenceId: 'U00096.2', chrom: 'U00096.2', start: 0, end: 100_000 },
        })
      );
      pointer(f.canvas, 'pointerdown', plot.x + 1, plot.y + 1);
      pointer(f.canvas, 'pointerup', plot.x + 1, plot.y + 1);
      expect(click).toHaveBeenLastCalledWith(
        expect.objectContaining({ cellId: 'contact-0-0', value: 25020 })
      );
      expect(f.state.highlightRange).toBeNull();
      expect(sequenceSelection).not.toHaveBeenCalled();
      const x = 10 + (plot.x + plot.width / 2) / 2;
      const y = 20 + (plot.y + plot.height / 2) / 2;
      f.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: x,
          clientY: y,
          deltaY: -50,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      const zoomed = f.renderer.getContactCamera(f.state)!;
      expect(zoomed.xEnd - zoomed.xStart).toBeLessThan(projection.xReference.length);
      expect(zoomed.yEnd - zoomed.yStart).toBeLessThan(projection.yReference.length);
      f.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: x,
          clientY: y,
          deltaX: 10,
          deltaY: 20,
          bubbles: true,
          cancelable: true,
        })
      );
      const panned = f.renderer.getContactCamera(f.state)!;
      expect(panned.xStart).toBeGreaterThan(zoomed.xStart);
      expect(panned.yStart).toBeGreaterThan(zoomed.yStart);
      expect(cameraChange).toHaveBeenCalledWith(
        expect.objectContaining({ projectionId: projection.id }),
        'zoom'
      );
      expect(f.state.zoom).toBe(3);
    } finally {
      interaction.cleanup();
      f.renderer.destroy();
    }
  });
  it('uses the contact X axis for native camera centering without changing Y or linear camera state', async () => {
    const f = await fixture();
    try {
      f.state.contactCamera = {
        projectionId: projection.id,
        xStart: 500_000,
        xEnd: 1_500_000,
        yStart: 2_000_000,
        yEnd: 3_000_000,
      };
      expect(f.renderer.getViewCenterBp(f.state)).toBe(1_000_000);
      f.renderer.setViewCenterBp(2_000_000, f.state);
      expect(f.renderer.getContactCamera(f.state)).toEqual({
        projectionId: projection.id,
        xStart: 1_500_000,
        xEnd: 2_500_000,
        yStart: 2_000_000,
        yEnd: 3_000_000,
      });
      expect(f.renderer.getMinZoom(f.state)).toBe(1);
      expect(f.state.zoom).toBe(3);
      expect(f.state.viewOffset).toBe(0.2);
    } finally {
      f.renderer.destroy();
    }
  });

  it('cancels an old contact pointer gesture when its projection is removed or replaced', async () => {
    const f = await fixture();
    const click = vi.fn();
    const sequenceSelection = vi.fn();
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
          contactProjection: projection,
          onContactClick: click,
          onSelectionChange: sequenceSelection,
        },
      },
      circular: false,
    });
    try {
      const plot = contactPlotRect(f.state.width, f.state.height);
      pointer(f.canvas, 'pointerdown', plot.x + 1, plot.y + 1);
      f.state.contactProjection = { ...projection, id: 'replacement-contact-source' };
      pointer(f.canvas, 'pointerup', plot.x + 1, plot.y + 1);
      expect(click).not.toHaveBeenCalled();
      expect(f.state.selectedContact).toBeNull();
      f.state.contactProjection = projection;
      pointer(f.canvas, 'pointerdown', plot.x + 1, plot.y + 1);
      f.state.contactProjection = null;
      pointer(f.canvas, 'pointerup', plot.x + 1, plot.y + 1);
      expect(sequenceSelection).not.toHaveBeenCalled();
      expect(f.state.highlightRange).toBeNull();
    } finally {
      interaction.cleanup();
      f.renderer.destroy();
    }
  });
  it('pans both axes during a native drag, clears contacts with Escape, and honors input revocation', async () => {
    const f = await fixture();
    const click = vi.fn();
    const changed = vi.fn();
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
          contactProjection: projection,
          onContactClick: click,
          onContactCameraChange: changed,
        },
      },
      circular: false,
    });
    try {
      f.renderer.setContactCamera(
        {
          projectionId: projection.id,
          xStart: 1_000_000,
          xEnd: 2_000_000,
          yStart: 2_000_000,
          yEnd: 3_000_000,
        },
        f.state
      );
      const before = f.renderer.getContactCamera(f.state)!;
      pointer(f.canvas, 'pointerdown', 500, 300);
      pointer(f.canvas, 'pointermove', 420, 240);
      pointer(f.canvas, 'pointerup', 420, 240);
      const after = f.renderer.getContactCamera(f.state)!;
      const plot = contactPlotRect(f.state.width, f.state.height);
      expect(after.xStart).toBeCloseTo(before.xStart + (80 / plot.width) * 1_000_000);
      expect(after.yStart).toBeCloseTo(before.yStart + (60 / plot.height) * 1_000_000);
      expect(click).not.toHaveBeenCalled();
      expect(changed).toHaveBeenLastCalledWith(after, 'scroll');
      f.state.selectedContact = {
        projectionId: projection.id,
        cellId: 'selected',
        x: { referenceId: 'x', chrom: 'x', start: 0, end: 1 },
        y: { referenceId: 'y', chrom: 'y', start: 0, end: 1 },
        value: 1,
      };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(f.state.selectedContact).toBeNull();
      expect(click).toHaveBeenLastCalledWith(null);
      interaction.isInputEnabled = () => false;
      pointer(f.canvas, 'pointerdown', 500, 300);
      pointer(f.canvas, 'pointermove', 400, 200);
      pointer(f.canvas, 'pointerup', 400, 200);
      expect(f.renderer.getContactCamera(f.state)).toEqual(after);
      expect(f.state.highlightRange).toBeNull();
    } finally {
      interaction.cleanup();
      f.renderer.destroy();
    }
  });
});
