// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Graphics, Text } from 'pixi.js';
import type { SequenceReadTrackData } from './sequence-read-track-renderer';
import type { TrackPaintArgs } from './types';
import { webglThemeForMode } from '../shared/theme';

let ReadRenderer: typeof import('./sequence-read-track-renderer').PixiSequenceReadTrackRenderer;
beforeAll(async () => {
  vi.stubGlobal('CanvasRenderingContext2D', class {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type) =>
    type === '2d'
      ? ({
          measureText: (text: string) => ({ width: text.length * 6 }),
          scale() {},
          fillText() {},
          clearRect() {},
        } as unknown as CanvasRenderingContext2D)
      : null
  );
  ReadRenderer = (await import('./sequence-read-track-renderer')).PixiSequenceReadTrackRenderer;
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const chromosome = { id: 'ref', displayName: 'ref', cytobands: [], length: 10 };
const theme = webglThemeForMode('light');
const read: Extract<SequenceReadTrackData, { kind: 'sanger' }> = {
  kind: 'sanger',
  label: 'read',
  sequence: 'AC',
  trace: {
    channels: { A: [10, 100], C: [5, 0], G: [0, 0], T: [0, 100] },
    peakPositions: [0, 1],
    maxValue: 100,
    baseOrder: 'ACGT',
  },
  quality: [40, 40],
  baseToColumn: [0, 1],
  mutationColumns: [],
  deletionColumns: [],
  mixedCalls: new Map([[0, 'M']]),
};

function draw(data: typeof read, scale: number, offset = 0) {
  const renderer = new ReadRenderer('chromatogram');
  const container = renderer.mount({ theme, chromosome });
  const marks = container.children[1] as Graphics;
  const markRect = vi.spyOn(marks, 'rect');
  const curves = container.children[2] as Graphics;
  const moveTo = vi.spyOn(curves, 'moveTo');
  const lineTo = vi.spyOn(curves, 'lineTo');
  const rect = vi.spyOn(curves, 'rect');
  renderer.paint({
    container,
    chromosome,
    theme,
    data,
    pathMapper: { pixelsPerBp: scale, bpLeftX: (column: number) => column * scale + offset },
    viewportWidthPx: scale * chromosome.length,
    layoutEntry: { height: 138 },
    viewportBpRange: { start: 0, end: chromosome.length },
  } as TrackPaintArgs<SequenceReadTrackData>);
  return { moveTo, lineTo, rect, markRect, diagnostics: renderer.getDiagnostics(container) };
}

it('amplifies weak peaks and clips the strongest peaks inside their own band', () => {
  const normal = draw(read, 8);
  const amplified = draw({ ...read, gain: 8 }, 8);
  expect(normal.lineTo.mock.calls).toContainEqual([4, expect.closeTo(88.7, 6)]);
  expect(amplified.lineTo.mock.calls).toContainEqual([4, expect.closeTo(30.6, 6)]);
  expect(amplified.lineTo.mock.calls).toContainEqual([12, 14]);
  expect(amplified.diagnostics).toMatchObject({ qualityBars: 2, baseGlyphs: 2, mixedCalls: 1 });
  expect(read.trace.channels.A).toEqual([10, 100]);
});

it('keeps quality below the waveform and samples tied to the read during fractional pans', () => {
  const panned = draw({ ...read, quality: [20, 40] }, 8, 0.375);
  expect(panned.markRect.mock.calls).toContainEqual([0.375, 109, 8, 11]);
  expect(panned.markRect.mock.calls).toContainEqual([8.375, 98, 8, 22]);
  const original = draw(read, 8);
  expect(panned.lineTo.mock.calls).toEqual(
    original.lineTo.mock.calls.map(([x, y]) => [x + 0.375, y])
  );
  expect(panned.lineTo.mock.calls).toContainEqual([5.375, expect.closeTo(79.3625, 6)]);
});

it('starts a separate curve after a deletion instead of drawing through its column', () => {
  const gap = draw({ ...read, baseToColumn: [0, 2], deletionColumns: [1] }, 8);
  expect(gap.moveTo.mock.calls.filter(([x]) => x === 16)).toHaveLength(4);
  expect(gap.lineTo.mock.calls.some(([x]) => x > 8 && x < 16)).toBe(false);
});

it('draws both covered portions of a circular overview and leaves the intervening span empty', () => {
  const wrapped = draw({ ...read, baseToColumn: [8, 11], cycleLength: 10 }, 1);
  expect(wrapped.rect.mock.calls).toEqual([
    [8, 62, 2, 12],
    [0, 62, 2, 12],
  ]);
});

it('retains a visible called-base glyph as the first displayed column changes', () => {
  const renderer = new ReadRenderer();
  const container = renderer.mount({ theme, chromosome });
  const paintWindow = (start: number, end: number) =>
    renderer.paint({
      container,
      chromosome,
      theme,
      data: read,
      pathMapper: { pixelsPerBp: 8, bpLeftX: (column: number) => (column - start) * 8 },
      viewportWidthPx: (end - start) * 8,
      layoutEntry: { height: 138 },
      viewportBpRange: { start, end },
    } as TrackPaintArgs<SequenceReadTrackData>);
  paintWindow(0, 2);
  const letter = (value: string) =>
    container.children.find((child) => 'text' in child && child.text === value) as Text;
  const second = letter('C');
  const mixed = letter('M');
  const firstX = second.x;
  paintWindow(1, 2);
  expect(letter('C')).toBe(second);
  expect(second.visible).toBe(true);
  expect(second.x).toBe(firstX - 8);
  expect(mixed.visible).toBe(false);
  paintWindow(0, 2);
  expect(letter('M')).toBe(mixed);
  expect(mixed.visible).toBe(true);
});
