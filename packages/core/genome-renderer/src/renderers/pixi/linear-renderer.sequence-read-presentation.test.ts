import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Application } from 'pixi.js';
import type { Genome, RenderState } from '../../types';
import type { Track } from '../../tracks';
import type { SequenceReadTrackData } from './linear-tracks/sequence-read-track-renderer';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

type LinearRenderer = InstanceType<(typeof import('./linear-renderer'))['PixiLinearRenderer']>;
type ReadData = Extract<SequenceReadTrackData, { kind: 'sanger' }>;
type PaintReceipt = Readonly<{
  paintCount: number;
  traceVisible: boolean;
  qualityVisible: boolean;
  basesVisible: boolean;
}>;

let pixi: typeof import('pixi.js');
let linearModule: typeof import('./linear-renderer');
let readModule: typeof import('./linear-tracks/sequence-read-track-renderer');
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalContextType = globalThis.CanvasRenderingContext2D;

beforeAll(async () => {
  if (typeof CanvasRenderingContext2D === 'undefined') {
    Object.assign(globalThis, { CanvasRenderingContext2D: class CanvasRenderingContext2D {} });
  }
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      scale: () => undefined,
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: () => undefined,
      clearRect: () => undefined,
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
  pixi = await import('pixi.js');
  linearModule = await import('./linear-renderer');
  readModule = await import('./linear-tracks/sequence-read-track-renderer');
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  Object.assign(globalThis, { CanvasRenderingContext2D: originalContextType });
});

function readData(): ReadData {
  return {
    kind: 'sanger',
    label: 'synthetic-owned-read',
    trace: {
      channels: {
        A: [0, 10, 20, 10, 0, 10, 20, 10, 0, 10, 20, 10, 0, 10, 20, 10],
        C: [10, 0, 10, 20, 10, 0, 10, 20, 10, 0, 10, 20, 10, 0, 10, 20],
        G: [20, 10, 0, 10, 20, 10, 0, 10, 20, 10, 0, 10, 20, 10, 0, 10],
        T: [10, 20, 10, 0, 10, 20, 10, 0, 10, 20, 10, 0, 10, 20, 10, 0],
      },
      peakPositions: [1, 3, 5, 7, 9, 11],
      baseOrder: 'ACGT',
      maxValue: 20,
    },
    sequence: 'ACGTAC',
    quality: [30, 31, 32, 33, 34, 35],
    baseToColumn: [0, 1, 2, 3, 4, 5],
    mutationColumns: [],
    deletionColumns: [],
  };
}

function receipt(renderer: LinearRenderer, trackId: string, expectedData: SequenceReadTrackData) {
  const getter: unknown = Reflect.get(renderer, 'getSequenceReadPaintReceipt');
  expect(typeof getter, 'CURRENT_TRACK_READ_PAINT_RECEIPT_MISSING').toBe('function');
  return Reflect.apply(
    getter as (trackId: string, expectedData: SequenceReadTrackData) => PaintReceipt | null,
    renderer,
    [trackId, expectedData]
  ) as PaintReceipt | null;
}

async function fixture(zone: Track['zone'] = 'below-legacy') {
  const state: RenderState = {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 120,
    height: 600,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: [0, 6],
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
  const genome: Genome = {
    name: 'synthetic-read-owner',
    length: 6,
    circular: false,
    features: [],
    sequence: 'ACGTAC',
  };
  const renderer = new linearModule.PixiLinearRenderer();
  const producer = new readModule.PixiSequenceReadTrackRenderer();
  const track: Track = {
    id: 'owned-read-lane',
    type: readModule.SEQUENCE_READ_TRACK_TYPE,
    order: 0,
    visible: true,
    assemblyId: 'owned',
    zone,
    sizing: { kind: 'fixed', pixels: 138 },
  };
  try {
    await renderer.init(
      {
        stage: new pixi.Container(),
        canvas: document.createElement('canvas'),
        renderer: {},
      } as unknown as Application,
      genome,
      () => state
    );
    renderer.setChromosome({ id: 'owned', displayName: 'Owned', length: 6, cytobands: [] });
    renderer.registerTrack(producer);
    renderer.setTrackInstances([track]);
    const data = readData();
    renderer.setTrackData(track.id, data);
    return { renderer, producer, track, data, state, genome };
  } catch (error) {
    renderer.destroy();
    throw error;
  }
}

describe('Sanger linear-renderer paint receipt owner', () => {
  it('delegates only the exact current painted lane to the known Sanger producer', async () => {
    const f = await fixture();
    try {
      f.renderer.render(f.state);
      expect(f.renderer.getTrackDiagnostics(f.track.id)).toMatchObject({
        kind: 'sanger',
        channelStrokes: 4,
        qualityBars: 6,
        baseGlyphs: 6,
      });
      expect(receipt(f.renderer, f.track.id, f.data)).toEqual({
        paintCount: 1,
        traceVisible: true,
        qualityVisible: true,
        basesVisible: true,
      });
      expect(receipt(f.renderer, f.track.id, { ...f.data })).toBeNull();
      expect(receipt(f.renderer, 'absent-lane', f.data)).toBeNull();
    } finally {
      f.renderer.destroy();
    }
  });

  it('refuses old and replacement data until the replacement actually paints', async () => {
    const f = await fixture();
    try {
      expect(receipt(f.renderer, f.track.id, f.data)).toBeNull();
      f.renderer.render(f.state);
      const prior = receipt(f.renderer, f.track.id, f.data);
      const replacement = readData();
      f.renderer.setTrackData(f.track.id, replacement);
      expect(receipt(f.renderer, f.track.id, f.data)).toBeNull();
      expect(receipt(f.renderer, f.track.id, replacement)).toBeNull();
      f.renderer.render(f.state);
      expect(receipt(f.renderer, f.track.id, replacement)!.paintCount).toBeGreaterThan(
        prior!.paintCount
      );
      expect(receipt(f.renderer, f.track.id, f.data)).toBeNull();
    } finally {
      f.renderer.destroy();
    }
  });

  it('refuses a lane as soon as it is hidden, removed or the renderer is destroyed', async () => {
    const f = await fixture();
    try {
      f.renderer.render(f.state);
      expect(receipt(f.renderer, f.track.id, f.data)).not.toBeNull();
      f.renderer.setTrackInstances([{ ...f.track, visible: false }]);
      expect(receipt(f.renderer, f.track.id, f.data)).toBeNull();
      f.renderer.setTrackInstances([]);
      expect(receipt(f.renderer, f.track.id, f.data)).toBeNull();
    } finally {
      f.renderer.destroy();
    }
    expect(receipt(f.renderer, f.track.id, f.data)).toBeNull();
  });

  it('preserves the real scrolling-mask top and the above-legacy exception', async () => {
    for (const zone of ['below-legacy', 'above-legacy'] as const) {
      const f = await fixture(zone);
      const paint = vi.spyOn(f.producer, 'paint');
      try {
        f.renderer.render(f.state);
        expect(paint).toHaveBeenCalledTimes(1);
        const args = paint.mock.calls[0]![0];
        const mask = f.renderer.getPresentedTrackScrollReceipt();
        expect(args.contentClipTopPx).toBe(zone === 'above-legacy' ? 0 : mask.contentClipTopPx);
        expect(receipt(f.renderer, f.track.id, f.data)).not.toBeNull();
      } finally {
        paint.mockRestore();
        f.renderer.destroy();
      }
    }
  });

  it('refuses a structurally compatible custom producer without invoking its receipt', async () => {
    const f = await fixture();
    const fabricated = vi.fn(() => ({
      paintCount: 99,
      traceVisible: true,
      qualityVisible: true,
      basesVisible: true,
    }));
    try {
      const renderer = new linearModule.PixiLinearRenderer();
      try {
        await renderer.init(
          {
            stage: new pixi.Container(),
            canvas: document.createElement('canvas'),
            renderer: {},
          } as unknown as Application,
          f.genome,
          () => f.state
        );
        renderer.setChromosome({ id: 'owned', displayName: 'Owned', length: 6, cytobands: [] });
        renderer.registerTrack({
          type: readModule.SEQUENCE_READ_TRACK_TYPE,
          mount: () => new pixi.Container(),
          paint: () => undefined,
          unmount: (container) => container.destroy({ children: true }),
          getPaintReceipt: fabricated,
        } as Parameters<LinearRenderer['registerTrack']>[0]);
        renderer.setTrackInstances([f.track]);
        renderer.setTrackData(f.track.id, f.data);
        renderer.render(f.state);
        expect(receipt(renderer, f.track.id, f.data)).toBeNull();
        expect(fabricated).not.toHaveBeenCalled();
      } finally {
        renderer.destroy();
      }
    } finally {
      fabricated.mockReset();
      f.renderer.destroy();
    }
  });
});
