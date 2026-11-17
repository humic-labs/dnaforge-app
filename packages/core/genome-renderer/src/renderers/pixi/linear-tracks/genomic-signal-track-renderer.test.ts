import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Graphics } from 'pixi.js';
import {
  resolveGenomicMarkup,
  type GenomicMarkupObservation,
  type GenomicMarkupSample,
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
  samples,
  sampleId = 'pairs',
}: {
  geometry?: GenomicMarkupStyle['geometry'];
  records?: GenomicMarkupObservation[];
  window?: { start: number; end: number };
  viewport?: { start: number; end: number };
  map?: (bp: number) => number;
  samples?: readonly GenomicMarkupSample[];
  sampleId?: string;
} = {}) {
  const data = resolveGenomicMarkup({
    dataset: {
      id: 'supplied-model',
      reference,
      unit: 'supplied model pair',
      samples: samples ?? [{ id: 'pairs', label: 'Supplied pairs', observations: records }],
    },
    sampleId,
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
    layoutEntry: { id: 'pairs', top: 30, height: renderer.getTrackHeight(data), contentClipped: false, hidden: false },
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

describe('native genomic sample matrix', () => {
  function matrix() {
    return setup({
      geometry: 'matrix',
      sampleId: 'second',
      window: { start: 100, end: 200 },
      viewport: { start: 0, end: 100 },
      map: (bp) => bp * 5,
      samples: [
        {
          id: 'first',
          label: 'First condition',
          observations: [
            { id: 'shared', label: 'Measured feature', start: 110, end: 114, value: 0 },
            { id: 'missing', start: 120, end: 124, value: null },
          ],
        },
        {
          id: 'second',
          label: 'Second condition',
          observations: [{ id: 'shared', start: 110, end: 114, value: 1 }],
        },
      ],
    });
  }

  type MatrixRow = {
    sampleId: string;
    label: string;
    topPx: number;
    heightPx: number;
    visibleRecordCount: number;
    sampleHits: Array<DiagnosticHit & { sampleId: string; record: { value: number | null; color: string } }>;
  };

  function rows(value: ReturnType<typeof setup>): MatrixRow[] {
    return (value.renderer.getDiagnostics(value.container) as { matrixRows: MatrixRow[] }).matrixRows;
  }

  it('paints ordered source rows with aligned cells and shared zero/missing colors in the actual Pixi graphics', () => {
    const value = matrix();
    const rect = vi.spyOn(value.graphics, 'rect');
    const fill = vi.spyOn(value.graphics, 'fill');
    value.renderer.paint(value.args);
    expect(value.graphics.context.instructions).toHaveLength(3);
    expect(rect.mock.calls).toEqual([[50, 44, 20, 12], [100, 44, 20, 12], [50, 74, 20, 12]]);
    expect(fill.mock.calls).toEqual([[0x000000], [0xcbd5e1], [0x123456]]);
    expect(rows(value).map(({ sampleId, label, visibleRecordCount }) => ({ sampleId, label, visibleRecordCount }))).toEqual([
      { sampleId: 'first', label: 'First condition', visibleRecordCount: 2 },
      { sampleId: 'second', label: 'Second condition', visibleRecordCount: 1 },
    ]);
    expect(rows(value)[0].sampleHits[0]).toMatchObject({ pickPoint: { x: 60, y: 50 }, sampleId: 'first', record: { value: 0, sourceStart: 110, sourceEnd: 114 } });
    expect(rows(value)[0].sampleHits[1].record).toMatchObject({ value: null, color: '#cbd5e1' });
    expect(rows(value)[1].sampleHits[0]).toMatchObject({ pickPoint: { x: 60, y: 80 }, sampleId: 'second', record: { value: 1 } });
    const labelTexts = value.container.children.filter((child) => 'text' in child).map((child) => (child as { text: string }).text);
    expect(labelTexts).toEqual(expect.arrayContaining(['First condition', 'Second condition', '2 samples · supplied model pair']));
    value.renderer.unmount(value.container);
  });

  it('picks the actual row and exact source interval without widening cells into neighboring positions', () => {
    const value = matrix();
    value.renderer.paint(value.args);
    const hit = rows(value)[1].sampleHits[0];
    const hoverArgs = { ...value.args, localX: hit.pickPoint.x, localY: hit.pickPoint.y };
    expect(value.renderer.hitTest(hoverArgs)).toEqual({ kind: 'select-bp-range', startBp: 10, endBp: 14, chromosomeId: 'rna', name: 'shared' });
    value.renderer.updateHover(hoverArgs);
    const tooltip = value.container.children.find((child) => 'text' in child && String(child.text).includes('source 110')) as unknown as { text: string; visible: boolean };
    expect(tooltip.text).toBe('Second condition (second) · shared: 1 supplied model pair · source 110–114');
    expect(tooltip.visible).toBe(true);
    expect(value.renderer.hitTest({ ...hoverArgs, localX: 71 })).toBeNull();
    expect(value.renderer.hitTest({ ...hoverArgs, localY: 65 })).toBeNull();
    const missing = rows(value)[0].sampleHits[1].pickPoint;
    value.renderer.updateHover({ ...value.args, localX: missing.x, localY: missing.y });
    expect(tooltip.text).toContain('First condition (first) · missing: missing supplied model pair');
    expect(value.renderer.hitTest({ ...value.args, localX: missing.x, localY: missing.y })).toMatchObject({ startBp: 20, endBp: 24 });
    value.renderer.unmount(value.container);
  });

  it('fits all 32 supported sample rows and keeps diagnostics bounded for native acceptance', () => {
    const value = setup({
      geometry: 'matrix',
      sampleId: 'sample-20',
      map: (bp) => bp * 5,
      samples: Array.from({ length: 32 }, (_, index) => ({
        id: `sample-${index}`,
        label: `Condition ${index}`,
        observations: Array.from({ length: 8 }, (_, record) => ({ id: `record-${record}`, start: record * 2, end: record * 2 + 1, value: index })),
      })),
    });
    value.renderer.paint(value.args);
    const matrixRows = rows(value);
    expect(matrixRows).toHaveLength(32);
    expect(matrixRows.every((row) => row.visibleRecordCount === 8 && row.sampleHits.length === 3)).toBe(true);
    expect(matrixRows[31].sampleHits[0].pickPoint.y).toBeLessThan(value.args.layoutEntry.height - 26);
    expect(value.renderer.getTrackHeight(value.args.data!)).toBe(1016);
    expect(diagnosticHits(value)).toHaveLength(5);
    value.renderer.unmount(value.container);
  });

  it('preserves the exact hovered sample value and cell outline through a repaint without pointer movement', () => {
    const value = matrix();
    try {
      value.renderer.paint(value.args);
      const hit = rows(value)[1].sampleHits[0];
      const hover = value.container.children[1] as Graphics;
      const rect = vi.spyOn(hover, 'rect');
      value.renderer.updateHover({ ...value.args, localX: hit.pickPoint.x, localY: hit.pickPoint.y });
      const tooltip = value.container.children.find((child) => 'text' in child && String(child.text).includes('source 110')) as unknown as { text: string; visible: boolean };
      const expectedText = 'Second condition (second) · shared: 1 supplied model pair · source 110–114';
      expect(tooltip.text).toBe(expectedText);
      expect(tooltip.visible).toBe(true);
      expect(hover.context.instructions).toHaveLength(1);
      expect(rect).toHaveBeenLastCalledWith(50, 74, 20, 12);

      value.renderer.paint(value.args);

      expect(tooltip.text).toBe(expectedText);
      expect.soft(tooltip.visible).toBe(true);
      expect(hover.context.instructions).toHaveLength(1);
      expect(rect).toHaveBeenLastCalledWith(50, 74, 20, 12);
    } finally {
      value.renderer.unmount(value.container);
    }
  });

  it('keeps the matrix tooltip and cell outline cleared when painting after pointer leave', () => {
    const value = matrix();
    try {
      value.renderer.paint(value.args);
      const hit = rows(value)[1].sampleHits[0];
      const hover = value.container.children[1] as Graphics;
      value.renderer.updateHover({ ...value.args, localX: hit.pickPoint.x, localY: hit.pickPoint.y });
      const tooltip = value.container.children.find((child) => 'text' in child && String(child.text).includes('source 110')) as unknown as { text: string; visible: boolean };
      expect(tooltip.visible).toBe(true);
      expect(hover.context.instructions).toHaveLength(1);

      value.renderer.clearHover(value.container);
      expect(tooltip.visible).toBe(false);
      expect(hover.context.instructions).toHaveLength(0);

      value.renderer.paint(value.args);

      expect(tooltip.visible).toBe(false);
      expect(hover.context.instructions).toHaveLength(0);
    } finally {
      value.renderer.unmount(value.container);
    }
  });
});

describe('native genomic sample matrix label bounds', () => {
  it('keeps full matrix hover text inside the track and viewport', () => {
    const sampleLabel = 'Long source sample condition '.repeat(20);
    const value = setup({
      geometry: 'matrix',
      sampleId: 'long',
      map: (bp) => bp * 5,
      samples: [{
        id: 'long',
        label: sampleLabel,
        observations: [{ id: 'measured', start: 10, end: 14, value: 1 }],
      }],
    });
    value.renderer.paint(value.args);
    const hit = diagnosticHits(value)[0];
    const hover = { ...value.args, localX: hit.pickPoint.x, localY: hit.pickPoint.y };
    value.renderer.updateHover({ ...hover, viewportWidthPx: 100 });
    const tooltip = value.container.children.find((child) => 'text' in child && String(child.text).includes('source 10')) as unknown as {
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      style: { wordWrap: boolean; breakWords: boolean };
    };
    expect(tooltip.text).toContain(`${sampleLabel} (long)`);
    expect(tooltip.style.wordWrap).toBe(true);
    expect(tooltip.style.breakWords).toBe(true);
    expect(tooltip.x + tooltip.width).toBeLessThanOrEqual(90);
    expect(tooltip.y + tooltip.height).toBeLessThanOrEqual(value.args.layoutEntry.height - 8);
    value.renderer.updateHover(hover);
    expect(tooltip.width).toBeGreaterThan(80);
    expect(tooltip.x + tooltip.width).toBeLessThanOrEqual(590);
    expect(tooltip.y + tooltip.height).toBeLessThanOrEqual(value.args.layoutEntry.height - 8);
    value.renderer.unmount(value.container);
  });

  it('bounds long multiline labels without moving cells and retains the full label on hover', () => {
    const sampleLabel = `Condition\n${'long sample label '.repeat(30)}\r\nreplicate`;
    const value = setup({
      geometry: 'matrix',
      sampleId: 'long',
      map: (bp) => bp * 5,
      samples: [{
        id: 'long',
        label: sampleLabel,
        observations: [{ id: 'measured', start: 10, end: 14, value: 1 }],
      }],
    });
    const rect = vi.spyOn(value.graphics, 'rect');
    value.renderer.paint(value.args);
    const label = value.container.children.find((child) => 'text' in child && child.y === 30) as unknown as {
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(label.text).not.toMatch(/[\r\n]/);
    expect(label.text.endsWith('…')).toBe(true);
    expect(label.width).toBeLessThanOrEqual(240);
    expect(label.y + label.height).toBeLessThan(44);
    expect(rect.mock.calls).toEqual([[50, 44, 20, 12]]);
    const hit = diagnosticHits(value)[0];
    expect(hit).toMatchObject({ x: 50, y: 44, width: 20, height: 12 });
    const hover = { ...value.args, localX: hit.pickPoint.x, localY: hit.pickPoint.y };
    expect(value.renderer.hitTest(hover)).toMatchObject({ startBp: 10, endBp: 14 });
    value.renderer.updateHover(hover);
    const tooltip = value.container.children.find((child) => 'text' in child && String(child.text).includes('source 10')) as unknown as { text: string };
    expect(tooltip.text).toContain(`${sampleLabel} (long)`);
    value.renderer.paint({ ...value.args, viewportWidthPx: 100 });
    expect(label.x + label.width).toBeLessThanOrEqual(90);
    expect(value.renderer.hitTest(hover)).toMatchObject({ startBp: 10, endBp: 14 });
    value.renderer.paint(value.args);
    expect(label.width).toBeGreaterThan(80);
    expect(label.width).toBeLessThanOrEqual(240);
    value.renderer.unmount(value.container);
  });
});
