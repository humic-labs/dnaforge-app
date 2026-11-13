// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawTranslationLabels1D } from '../translation-labels-1d';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  type CanvasOp,
} from '../testing/recording-canvas-context';
import type { ClassifiedCDS } from '../types';

const cds = (overrides: Partial<ClassifiedCDS> = {}): ClassifiedCDS => ({
  type: 'CDS',
  name: 'TestCDS',
  start: 1,
  end: 120,
  direction: 1,
  cdsType: 'full',
  translationLane: 0,
  ...overrides,
});

const drawWith = (
  ctx: CanvasRenderingContext2D,
  cdss: ClassifiedCDS[],
  annotationRenderStateInput?: { hovered?: ClassifiedCDS; selected?: ClassifiedCDS } | undefined
) => {
  drawTranslationLabels1D(ctx, {
    cdss,
    pxPerBase: 10,
    columnCount: 240,
    sequenceLength: 240,
    viewportLeftX: 0,
    viewportRightX: 2400,
    originX: 0,
    bandTopY: 100,
    laneHeight: 40,
    labelFontSize: 12,
    labelFontFamily: 'monospace',
    annotationRenderStateInput: annotationRenderStateInput
      ? {
          hovered: annotationRenderStateInput.hovered ?? null,
          selected: annotationRenderStateInput.selected ?? null,
        }
      : undefined,
  });
};

const setValuesOf = (log: CanvasOp[], prop: string): unknown[] =>
  log
    .filter((e): e is Extract<CanvasOp, { op: 'set' }> => e.op === 'set' && e.prop === prop)
    .map((e) => e.value);

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

beforeEach(() => {
  installRecordingCanvas();
  canvas = document.createElement('canvas');
  ctx = canvas.getContext('2d')!;
});

afterEach(() => {
  uninstallRecordingCanvas();
});

describe('drawTranslationLabels1D — hover/select outline rendering', () => {
  it('keeps only the gene name and never paints exon/intron decorations or lengths', () => {
    const target = cds({
      segments: [
        { start: 1, end: 30 },
        { start: 91, end: 120 },
      ],
      qualifiers: { _locationString: ['join(1..30,91..120)'] },
    });
    drawWith(ctx, [target]);
    const texts = getRecordingLog(canvas)
      .filter((op): op is Extract<CanvasOp, { op: 'fillText' }> => op.op === 'fillText')
      .map((op) => op.text);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((text) => text === 'TestCDS')).toBe(true);
  });
  it('does NOT stroke outlines when no render-state input is provided', () => {
    const target = cds();
    drawWith(ctx, [target]);
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).not.toContain(2.5);
    expect(lineWidths).not.toContain(1.5);
  });

  it('strokes a SELECTED outline (lineWidth 2.5) when selected matches the CDS', () => {
    const target = cds();
    drawWith(ctx, [target], { selected: target });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).toContain(2.5);
    const strokes = log.filter((e) => e.op === 'stroke').length;
    expect(strokes).toBeGreaterThan(0);
  });

  it('strokes a HOVERED outline (lineWidth 1.5) when hovered matches the CDS', () => {
    const target = cds();
    drawWith(ctx, [target], { hovered: target });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).toContain(1.5);
    const strokes = log.filter((e) => e.op === 'stroke').length;
    expect(strokes).toBeGreaterThan(0);
  });

  it('selected wins over hovered (priority chain)', () => {
    const target = cds();
    drawWith(ctx, [target], { hovered: target, selected: target });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).toContain(2.5);
    expect(lineWidths).not.toContain(1.5);
  });

  it('does NOT outline a different CDS when only one is selected', () => {
    const target = cds({ name: 'A', start: 1, end: 60 });
    const other = cds({ name: 'B', start: 70, end: 120, translationLane: 0 });
    drawWith(ctx, [target, other], { selected: target });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).toContain(2.5);
    expect(lineWidths).not.toContain(1.5);
  });

  it('discriminates by type (gene at same range does NOT trigger CDS outline)', () => {
    const cdsTarget = cds({ type: 'CDS', name: 'rbcL' });
    const geneTwin = {
      type: 'gene',
      name: 'rbcL',
      start: 1,
      end: 120,
      direction: 1 as const,
    };
    drawWith(ctx, [cdsTarget], {
      // @ts-expect-error — geneTwin has no cdsType/translationLane, but
      hovered: geneTwin,
    });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).not.toContain(2.5);
    expect(lineWidths).not.toContain(1.5);
  });
});
