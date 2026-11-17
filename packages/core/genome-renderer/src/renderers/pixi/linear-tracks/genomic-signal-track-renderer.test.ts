import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Graphics } from 'pixi.js';
import {
  resolveGenomicMarkup,
  type GenomicMarkupObservation,
  type GenomicMarkupStyle,
  type ResolvedGenomicMarkup,
} from '@waypoint/genome-data';
import type { TrackPaintArgs } from './types';
import { webglThemeForMode } from '../shared/theme';

let PixiGenomicSignalTrackRenderer: (typeof import('./genomic-signal-track-renderer'))['PixiGenomicSignalTrackRenderer'];

beforeAll(async () => {
  vi.stubGlobal('CanvasRenderingContext2D', class {});
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      fillStyle: '',
      fillRect: () => undefined,
      drawImage: () => undefined,
      measureText: (text: string) => ({
        width: text.length * 6,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 3,
      }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
  ({ PixiGenomicSignalTrackRenderer } = await import('./genomic-signal-track-renderer'));
});

const reference = { id: 'rna', chrom: 'rna', length: 432 };
const chromosome = { id: 'rna', displayName: 'RNA', length: 432, cytobands: [] };
const pair = { id: 'supplied-pair', label: '11–41', start: 10, end: 41, value: 1 };
const colorScale: GenomicMarkupStyle['colorScale'] = {
  kind: 'continuous',
  domain: [0, 1],
  colors: ['#000000', '#123456'],
  missingColor: '#cbd5e1',
  transform: 'linear',
};

function setup({
  geometry = 'arcs',
  records = [pair],
  window = { start: 0, end: 432 },
  viewport = { start: 0, end: 432 },
  map = (bp: number) => bp * 5 + (bp >= 20 ? 100 : 0),
}: {
  geometry?: GenomicMarkupStyle['geometry'];
  records?: GenomicMarkupObservation[];
  window?: { start: number; end: number };
  viewport?: { start: number; end: number };
  map?: (bp: number) => number;
} = {}) {
  const data = resolveGenomicMarkup({
    dataset: {
      id: 'supplied-model',
      reference,
      unit: 'supplied model pair',
      samples: [{ id: 'pairs', label: 'Supplied pairs', observations: records }],
    },
    sampleId: 'pairs',
    window: { reference, ...window },
    style: { geometry, colorScale },
  });
  const renderer = new PixiGenomicSignalTrackRenderer();
  const container = renderer.mount({ chromosome, theme: webglThemeForMode('light') });
  const args = {
    container,
    data,
    presentation: {},
    chromosome,
    pathMapper: { bpLeftX: map, pixelsPerBp: 5 },
    viewportBpRange: viewport,
    viewportWidthPx: 600,
    viewportHeightPx: 400,
    layoutEntry: { id: 'pairs', top: 30, height: 190, contentClipped: false, hidden: false },
    containerTopPx: 30,
    theme: webglThemeForMode('light'),
  } as unknown as TrackPaintArgs<ResolvedGenomicMarkup>;
  return { renderer, container, args, graphics: container.children[0] as Graphics };
}

type DiagnosticHit = {
  x: number;
  y: number;
  width: number;
  height: number;
  pickPoint: { x: number; y: number };
  record: { sourceStart: number; sourceEnd: number };
};

function diagnosticHits(value: ReturnType<typeof setup>): DiagnosticHit[] {
  return (value.renderer.getDiagnostics(value.container) as { sampleHits: DiagnosticHit[] })
    .sampleHits;
}

describe('native genomic span arcs', () => {
  it('draws endpoint base centers through the actual mapper and retains value-based color', () => {
    const value = setup();
    const move = vi.spyOn(value.graphics, 'moveTo');
    const curve = vi.spyOn(value.graphics, 'quadraticCurveTo');
    const stroke = vi.spyOn(value.graphics, 'stroke');
    value.renderer.paint(value.args);

    expect(move).toHaveBeenCalledWith(52.5, 156);
    expect(curve).toHaveBeenCalledWith(177.5, -44, 302.5, 156);
    expect(stroke).toHaveBeenCalledWith({ color: 0x123456, alpha: 0.85, width: 1.5 });
    expect(diagnosticHits(value)[0]).toMatchObject({
      pickPoint: { x: 177.5, y: 56 },
      record: { sourceStart: 10, sourceEnd: 41 },
    });
    value.renderer.unmount(value.container);
  });

  it('selects the native interval only on the curve, including its endpoints', () => {
    const value = setup();
    value.renderer.paint(value.args);
    const hit = diagnosticHits(value)[0];
    const at = (localX: number, localY: number) =>
      value.renderer.hitTest({ ...value.args, localX, localY });

    expect(at(hit.pickPoint.x, hit.pickPoint.y)).toEqual({
      kind: 'select-bp-range',
      startBp: 10,
      endBp: 41,
      chromosomeId: 'rna',
      name: '11–41',
    });
    expect(at(52.5, 156)).not.toBeNull();
    expect(at(302.5, 156)).not.toBeNull();
    expect(at(hit.pickPoint.x, 148)).toBeNull();
    expect(at(hit.pickPoint.x, hit.pickPoint.y - 9)).toBeNull();
    value.renderer.updateHover({ ...value.args, localX: hit.pickPoint.x, localY: hit.pickPoint.y });
    const hover = value.container.children[1] as Graphics;
    expect(hover.context.instructions).toHaveLength(1);
    value.renderer.unmount(value.container);
  });

  it('omits pairs with an unrepresented endpoint but preserves original endpoints while zooming', () => {
    const cropped = setup({
      window: { start: 15, end: 45 },
      records: [
        pair,
        { ...pair, id: 'inside', start: 20, end: 35 },
        { ...pair, id: 'right-outside', start: 40, end: 60 },
      ],
      map: (bp) => bp * 5,
    });
    cropped.renderer.paint(cropped.args);
    expect(diagnosticHits(cropped)).toHaveLength(1);
    expect(diagnosticHits(cropped)[0].record).toMatchObject({ sourceStart: 20, sourceEnd: 35 });
    cropped.renderer.unmount(cropped.container);

    const zoomed = setup({ viewport: { start: 20, end: 30 }, map: (bp) => (bp - 20) * 20 });
    const curve = vi.spyOn(zoomed.graphics, 'quadraticCurveTo');
    zoomed.renderer.paint(zoomed.args);
    expect(curve).toHaveBeenCalledWith(110, -84, 410, 156);
    expect(diagnosticHits(zoomed)[0].pickPoint).toEqual({ x: 110, y: 36 });
    zoomed.renderer.unmount(zoomed.container);
  });

  it('uses smaller rises for short spans within the same fixed track height', () => {
    const value = setup({
      records: [pair, { ...pair, id: 'short', start: 10, end: 13 }],
      map: (bp) => bp * 5,
    });
    value.renderer.paint(value.args);
    const hits = diagnosticHits(value);
    expect(hits[1].pickPoint.y).toBeGreaterThan(hits[0].pickPoint.y);
    expect(hits[0].pickPoint.y).toBeGreaterThanOrEqual(36);
    expect(hits[1].pickPoint.y).toBeLessThan(156);
    value.renderer.unmount(value.container);
  });

  it.each(['bars', 'band', 'points'] as const)(
    'keeps %s on its established geometry and hit path',
    (geometry) => {
      const value = setup({ geometry, map: (bp) => bp * 5 });
      const curve = vi.spyOn(value.graphics, 'quadraticCurveTo');
      value.renderer.paint(value.args);
      const hit = diagnosticHits(value)[0];
      expect(curve).not.toHaveBeenCalled();
      expect(
        value.renderer.hitTest({ ...value.args, localX: hit.x + 2, localY: hit.y + 2 })
      ).toMatchObject({
        startBp: 10,
        endBp: 41,
      });
      value.renderer.unmount(value.container);
    }
  );
});
