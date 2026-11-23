import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Container } from 'pixi.js';
import type { TrackMountArgs, TrackPaintArgs } from './types';
import type { SequenceReadTrackData } from './sequence-read-track-renderer';

type ReadData = Extract<SequenceReadTrackData, { kind: 'sanger' }>;
type PaintReceipt = Readonly<{
  paintCount: number;
  traceVisible: boolean;
  qualityVisible: boolean;
  basesVisible: boolean;
}>;
type ReadRenderer = InstanceType<
  (typeof import('./sequence-read-track-renderer'))['PixiSequenceReadTrackRenderer']
>;

let rendererModule: typeof import('./sequence-read-track-renderer');
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
  rendererModule = await import('./sequence-read-track-renderer');
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  Object.assign(globalThis, { CanvasRenderingContext2D: originalContextType });
});

const chromosome = { id: 'owned-read', displayName: 'Owned read', length: 6, cytobands: [] };
const mountArgs = { chromosome, theme: { mode: 'light' } } as TrackMountArgs;

function readData(quality: readonly number[] | undefined = [30, 31, 32, 33, 34, 35]): ReadData {
  return {
    kind: 'sanger',
    label: 'synthetic-only-read',
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
    quality,
    baseToColumn: [0, 1, 2, 3, 4, 5],
    mutationColumns: [],
    deletionColumns: [],
  };
}

function paintArgs(container: Container, data: SequenceReadTrackData | null) {
  return {
    container,
    data,
    chromosome,
    pathMapper: { pixelsPerBp: 10, bpLeftX: (bp: number) => bp * 10 },
    viewportBpRange: { start: 0, end: 6 },
    viewportWidthPx: 60,
    viewportHeightPx: 200,
    layoutEntry: { id: 'owned-lane', top: 0, height: 138, contentClipped: false, hidden: false },
    containerTopPx: 0,
    presentation: { visible: true },
    theme: { mode: 'light' },
  } as unknown as TrackPaintArgs<SequenceReadTrackData>;
}

function receipt(
  renderer: ReadRenderer,
  container: Container,
  expectedData: SequenceReadTrackData
) {
  const getter: unknown = Reflect.get(renderer, 'getPaintReceipt');
  expect(typeof getter, 'CURRENT_READ_PAINT_IDENTITY_RECEIPT_MISSING').toBe('function');
  return Reflect.apply(
    getter as (container: Container, expectedData: SequenceReadTrackData) => PaintReceipt | null,
    renderer,
    [container, expectedData]
  ) as PaintReceipt | null;
}

describe('Sanger read paint ownership', () => {
  it('attests only the exact successfully painted Sanger data', () => {
    const renderer = new rendererModule.PixiSequenceReadTrackRenderer();
    const container = renderer.mount(mountArgs);
    const data = readData();
    try {
      renderer.paint(paintArgs(container, data));
      expect(renderer.getDiagnostics(container)).toMatchObject({
        kind: 'sanger',
        channelStrokes: 4,
        qualityBars: 6,
        baseGlyphs: 6,
      });
      const painted = receipt(renderer, container, data);
      expect(painted).toEqual({
        paintCount: 1,
        traceVisible: true,
        qualityVisible: true,
        basesVisible: true,
      });
      expect(receipt(renderer, container, { ...data })).toBeNull();
      expect(Object.keys(painted!).sort()).toEqual([
        'basesVisible',
        'paintCount',
        'qualityVisible',
        'traceVisible',
      ]);
    } finally {
      renderer.unmount(container);
    }
  });

  it('refuses unpainted, replaced, non-Sanger and unmounted data', () => {
    const renderer = new rendererModule.PixiSequenceReadTrackRenderer();
    const container = renderer.mount(mountArgs);
    const first = readData();
    const second = readData();
    try {
      expect(receipt(renderer, container, first)).toBeNull();
      renderer.paint(paintArgs(container, first));
      renderer.paint(paintArgs(container, second));
      expect(receipt(renderer, container, first)).toBeNull();
      expect(receipt(renderer, container, second)?.paintCount).toBe(2);
      const alignment: SequenceReadTrackData = {
        kind: 'alignment',
        label: 'synthetic-alignment',
        alignedReference: 'ACGTAC',
        alignedQuery: 'ACGTAC',
      };
      renderer.paint(paintArgs(container, alignment));
      expect(receipt(renderer, container, alignment)).toBeNull();
      expect(receipt(renderer, container, second)).toBeNull();
    } finally {
      renderer.unmount(container);
    }
    expect(receipt(renderer, container, second)).toBeNull();
  });

  it('refuses hidden and fully offscreen lanes without reusing old paint', () => {
    const renderer = new rendererModule.PixiSequenceReadTrackRenderer();
    const container = renderer.mount(mountArgs);
    const data = readData();
    try {
      renderer.paint(paintArgs(container, data));
      container.visible = false;
      expect(receipt(renderer, container, data)).toBeNull();
      container.visible = true;
      const offscreen = paintArgs(container, data);
      renderer.paint({ ...offscreen, containerTopPx: offscreen.viewportHeightPx + 1 });
      expect(receipt(renderer, container, data)).toBeNull();
      renderer.paint({
        ...offscreen,
        layoutEntry: { ...offscreen.layoutEntry, hidden: true },
      });
      expect(receipt(renderer, container, data)).toBeNull();
      renderer.paint(paintArgs(container, null));
      expect(receipt(renderer, container, data)).toBeNull();
    } finally {
      renderer.unmount(container);
    }
  });

  it('invalidates an earlier eligible receipt when a later paint throws', () => {
    const renderer = new rendererModule.PixiSequenceReadTrackRenderer();
    const container = renderer.mount(mountArgs);
    const data = readData();
    try {
      renderer.paint(paintArgs(container, data));
      const prior = receipt(renderer, container, data);
      const failure = { ownedPaintFailure: true };
      const failed = paintArgs(container, data);
      let thrown: unknown;
      try {
        renderer.paint({
          ...failed,
          pathMapper: {
            ...failed.pathMapper,
            bpLeftX: () => {
              throw failure;
            },
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      expect(receipt(renderer, container, data)).toBeNull();
      renderer.paint(paintArgs(container, data));
      expect(receipt(renderer, container, data)!.paintCount).toBeGreaterThan(prior!.paintCount);
    } finally {
      renderer.unmount(container);
    }
  });

  it('advances paint identity only on a new paint and keeps containers independent', () => {
    const renderer = new rendererModule.PixiSequenceReadTrackRenderer();
    const first = renderer.mount(mountArgs);
    const second = renderer.mount(mountArgs);
    const data = readData();
    try {
      renderer.paint(paintArgs(first, data));
      const before = receipt(renderer, first, data);
      expect(receipt(renderer, first, data)).toEqual(before);
      expect(receipt(renderer, second, data)).toBeNull();
      renderer.paint(paintArgs(second, data));
      expect(receipt(renderer, first, data)).toEqual(before);
      renderer.paint(paintArgs(first, data));
      expect(receipt(renderer, first, data)!.paintCount).toBeGreaterThan(before!.paintCount);
    } finally {
      renderer.unmount(first);
      renderer.unmount(second);
    }
  });

  it('keeps quality admission distinct from physically visible positive-quality bars', () => {
    const renderer = new rendererModule.PixiSequenceReadTrackRenderer();
    const container = renderer.mount(mountArgs);
    const data = readData([0, 0, 0, 0, 0, 0]);
    try {
      renderer.paint(paintArgs(container, data));
      expect(renderer.getDiagnostics(container)).toMatchObject({
        channelStrokes: 4,
        qualityBars: 0,
        baseGlyphs: 6,
      });
      expect(receipt(renderer, container, data)).toMatchObject({
        traceVisible: true,
        qualityVisible: false,
        basesVisible: true,
      });
      expect(data.sequence).toBe('ACGTAC');
      expect(data.quality).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      renderer.unmount(container);
    }
  });

  it('reports only read bands intersecting a partially clipped viewport', () => {
    const renderer = new rendererModule.PixiSequenceReadTrackRenderer();
    const container = renderer.mount(mountArgs);
    const data = readData();
    const args = paintArgs(container, data);
    try {
      container.position.set(0, 194);
      renderer.paint({ ...args, containerTopPx: 194 });
      const labelOnly = receipt(renderer, container, data);
      expect(labelOnly?.traceVisible ?? false).toBe(false);
      expect(labelOnly?.qualityVisible ?? false).toBe(false);
      expect(labelOnly?.basesVisible ?? false).toBe(false);

      container.position.set(0, -100);
      renderer.paint({ ...args, containerTopPx: -100 });
      expect(receipt(renderer, container, data)).toMatchObject({
        traceVisible: false,
        qualityVisible: true,
        basesVisible: true,
      });

      container.position.set(0, 150);
      renderer.paint({ ...args, containerTopPx: 150 });
      expect(receipt(renderer, container, data)).toMatchObject({
        traceVisible: true,
        qualityVisible: false,
        basesVisible: false,
      });
    } finally {
      renderer.unmount(container);
    }
  });

  it('respects the real scrolling-parent clip top for each read band', () => {
    const renderer = new rendererModule.PixiSequenceReadTrackRenderer();
    const container = renderer.mount(mountArgs);
    const data = readData();
    const args = paintArgs(container, data);
    try {
      const masked = { ...args, contentClipTopPx: 100 };
      renderer.paint(masked);
      expect(receipt(renderer, container, data)).toMatchObject({
        traceVisible: false,
        qualityVisible: true,
        basesVisible: true,
      });
      const fullyMasked = { ...args, contentClipTopPx: args.viewportHeightPx };
      renderer.paint(fullyMasked);
      const hidden = receipt(renderer, container, data);
      expect(hidden?.traceVisible ?? false).toBe(false);
      expect(hidden?.qualityVisible ?? false).toBe(false);
      expect(hidden?.basesVisible ?? false).toBe(false);
    } finally {
      renderer.unmount(container);
    }
  });
});
