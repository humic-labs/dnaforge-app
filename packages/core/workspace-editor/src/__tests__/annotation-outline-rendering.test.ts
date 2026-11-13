/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawAnnotations } from '../canvas-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  type CanvasOp,
} from '../testing/recording-canvas-context';
import type { Annotation } from '../types';
import {
  annotationKeyOf,
  annotationRenderState,
  type AnnotationStateIdentity,
} from '../annotation-render-state';

const ann = (
  overrides: Partial<Annotation & { lane: number }> = {}
): Annotation & {
  lane: number;
} => ({
  type: 'gene',
  name: 'rbcL',
  start: 1,
  end: 60,
  direction: 1,
  lane: 0,
  ...overrides,
});

const drawWith = (
  ctx: CanvasRenderingContext2D,
  annotations: Array<Annotation & { lane: number }>,
  annotationRenderStateInput?: { hovered?: Annotation; selected?: Annotation }
) => {
  drawAnnotations(
    ctx,
    annotations,
    0,
    240,
    0,
    100,
    1,
    DEFAULT_EDITOR_CONFIG,
    240,
    undefined,
    annotationRenderStateInput
      ? {
          hovered: annotationRenderStateInput.hovered ?? null,
          selected: annotationRenderStateInput.selected ?? null,
        }
      : undefined,
    false
  );
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

describe('drawAnnotations — hover/select outline rendering for regular annotations', () => {
  it('does NOT stroke outlines when no render-state input is provided', () => {
    drawWith(ctx, [ann()]);
    const log = getRecordingLog(canvas);
    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).not.toContain(2.5);
    expect(lineWidths).not.toContain(1.5);
  });

  it('strokes a SELECTED outline (lineWidth 2.5) when selected matches the annotation', () => {
    const target = ann();
    drawWith(ctx, [target], { selected: target });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).toContain(2.5);
    const strokes = log.filter((e) => e.op === 'stroke').length;
    expect(strokes).toBeGreaterThan(0);
  });

  it('strokes a HOVERED outline (lineWidth 1.5) when hovered matches the annotation', () => {
    const target = ann();
    drawWith(ctx, [target], { hovered: target });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).toContain(1.5);
    const strokes = log.filter((e) => e.op === 'stroke').length;
    expect(strokes).toBeGreaterThan(0);
  });

  it('selected wins over hovered (priority chain — same identity)', () => {
    const target = ann();
    drawWith(ctx, [target], { hovered: target, selected: target });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).toContain(2.5);
    expect(lineWidths).not.toContain(1.5);
  });

  it('different annotations get independent render states', () => {
    const a = ann({ name: 'A', start: 1, end: 60 });
    const b = ann({ name: 'B', start: 80, end: 140, lane: 0 });
    drawWith(ctx, [a, b], { selected: a, hovered: b });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');

    expect(lineWidths).toContain(2.5);

    expect(lineWidths).toContain(1.5);
  });

  it('discriminates by type — CDS hovered does NOT outline a coextensive gene', () => {
    const geneTarget = ann({ type: 'gene', name: 'rbcL' });
    const cdsTwin: Annotation = {
      type: 'CDS',
      name: 'rbcL',
      start: 1,
      end: 60,
      direction: 1,
    };
    drawWith(ctx, [geneTarget], { hovered: cdsTwin });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');

    expect(lineWidths).not.toContain(2.5);
    expect(lineWidths).not.toContain(1.5);
  });

  it('reverse-strand annotations also receive outlines on match', () => {
    const reverseGene = ann({ direction: -1, start: 60, end: 1 });
    drawWith(ctx, [reverseGene], { selected: reverseGene });
    const log = getRecordingLog(canvas);

    const lineWidths = setValuesOf(log, 'lineWidth');
    expect(lineWidths).toContain(2.5);
  });
});

describe('annotation identity parity', () => {
  const identity: AnnotationStateIdentity = {
    type: 'CDS',
    name: 'gene',
    start: 1,
    end: 60,
    direction: 1,
  };

  it.each([
    {
      name: 'default direction and signed zero',
      state: 'selected',
      annotation: { ...identity, start: -0, direction: undefined },
      selected: { ...identity, start: 0, direction: 0 },
    },
    {
      name: 'delimiter-containing type and name',
      state: 'selected',
      annotation: { ...identity, type: 'CDS|gene', name: 'copy' },
      selected: { ...identity, type: 'CDS', name: 'gene|copy' },
    },
    {
      name: 'non-finite coordinates',
      state: 'selected',
      annotation: { ...identity, start: NaN, end: Infinity },
      selected: { ...identity, start: NaN, end: Infinity },
    },
    {
      name: 'legacy numeric text',
      state: 'hovered',
      annotation: identity,
      selected: { ...identity, start: '1' as unknown as number },
    },
    {
      name: 'malformed coordinate delimiter',
      state: 'hovered',
      annotation: { ...identity, start: 1, end: '2|3' as unknown as number, direction: 4 },
      selected: { ...identity, name: 'gene|1', start: 2, end: 3, direction: 4 },
    },
  ])(
    'checks coordinate identity independently of legacy keys for $name',
    ({ annotation, selected, state }) => {
      expect(annotationKeyOf(annotation)).toBe(annotationKeyOf(selected));
      expect(annotationRenderState(annotation, { selected, hovered: annotation })).toBe(state);
    }
  );

  it('rejects unrelated coordinates while retaining hover and observing mutable input identities', () => {
    const selected = { ...identity, start: 2 };
    const input = { selected, hovered: { ...identity } };
    expect(annotationRenderState(identity, input)).toBe('hovered');
    selected.start = identity.start;
    expect(annotationRenderState(identity, input)).toBe('selected');
    selected.name = 'another gene';
    expect(annotationRenderState(identity, input)).toBe('hovered');
    input.hovered.end = identity.end + 1;
    expect(annotationRenderState(identity, input)).toBe('default');
  });
});
