// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from 'vitest';
import type { Graphics } from 'pixi.js';
import type { SequenceReadTrackData } from './sequence-read-track-renderer';
import type { TrackPaintArgs } from './types';
import { webglThemeForMode } from '../shared/theme';

let ReadRenderer: typeof import('./sequence-read-track-renderer').PixiSequenceReadTrackRenderer;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  ReadRenderer = (await import('./sequence-read-track-renderer')).PixiSequenceReadTrackRenderer;
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

function draw(data: typeof read, scale: number) {
  const renderer = new ReadRenderer();
  const container = renderer.mount({ theme, chromosome });
  const curves = container.children[2] as Graphics;
  const lineTo = vi.spyOn(curves, 'lineTo');
  const rect = vi.spyOn(curves, 'rect');
  renderer.paint({
    container,
    chromosome,
    theme,
    data,
    pathMapper: { pixelsPerBp: scale, bpLeftX: (column: number) => column * scale },
    viewportWidthPx: scale * chromosome.length,
    layoutEntry: { height: 138 },
    viewportBpRange: { start: 0, end: chromosome.length },
  } as TrackPaintArgs<SequenceReadTrackData>);
  return { lineTo, rect, diagnostics: renderer.getDiagnostics(container) };
}

it('amplifies weak peaks and clips the strongest peaks inside their own band', () => {
  const normal = draw(read, 8);
  const amplified = draw({ ...read, gain: 8 }, 8);
  expect(normal.lineTo.mock.calls).toContainEqual([4, 122.8]);
  expect(amplified.lineTo.mock.calls).toContainEqual([4, expect.closeTo(72.4, 6)]);
  expect(amplified.lineTo.mock.calls).toContainEqual([12, 58]);
  expect(amplified.diagnostics).toMatchObject({ qualityBars: 2, baseGlyphs: 2, mixedCalls: 1 });
  expect(read.trace.channels.A).toEqual([10, 100]);
});

it('draws both covered portions of a circular overview and leaves the intervening span empty', () => {
  const wrapped = draw({ ...read, baseToColumn: [8, 11], cycleLength: 10 }, 1);
  expect(wrapped.rect.mock.calls).toEqual([
    [8, 62, 2, 12],
    [0, 62, 2, 12],
  ]);
});
