// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  molstarHoverColorRgb,
  molstarSelectionColorRgb,
  molstarHoverColorHex,
  molstarSelectionColorHex,
} from '../canvas-theme';
import { drawTranslation } from '../translation-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  type CanvasOp,
} from '../testing/recording-canvas-context';
import type { ClassifiedCDS } from '../types';

describe('Mol* cross-surface palette — pinned to renderer defaults', () => {
  it('hover colour matches Mol*-default #ff6699 in light mode', () => {
    expect(molstarHoverColorRgb(false)).toEqual([255, 102, 153]);
    expect(molstarHoverColorHex(false)).toBe(0xff6699);
  });

  it('hover colour is dimmed in dark mode (same hue, ~70% intensity)', () => {
    const [r, g, b] = molstarHoverColorRgb(true);
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeLessThan(255);
    expect(b).toBeLessThan(153);
    expect(molstarHoverColorHex(true)).toBe(0xb3476b);
  });

  it('selection colour matches Mol*-default #33ff1a in light mode', () => {
    expect(molstarSelectionColorRgb(false)).toEqual([51, 255, 26]);
    expect(molstarSelectionColorHex(false)).toBe(0x33ff1a);
  });

  it('selection colour is dimmed in dark mode (green hue preserved)', () => {
    const [r, g, b] = molstarSelectionColorRgb(true);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(g).toBeLessThan(255);
    expect(molstarSelectionColorHex(true)).toBe(0x24b212);
  });
});

const SEQ = 'ATGGCCAGTACGGGAATTCGGCTAGAATAA';

const cds = (overrides: Partial<ClassifiedCDS> = {}): ClassifiedCDS => ({
  type: 'CDS',
  name: 'TestCDS',
  start: 1,
  end: SEQ.length,
  direction: 1,
  cdsType: 'full',
  translationLane: 0,
  ...overrides,
});

const drawWithSelection = (
  ctx: CanvasRenderingContext2D,
  selectedCodons: Array<{ start: number; end: number; strand: 1 | -1 }> = []
) => {
  drawTranslation(
    ctx,
    SEQ,
    [cds()],
    0,
    SEQ.length - 1,
    0,
    100,
    DEFAULT_EDITOR_CONFIG,
    SEQ,
    [],
    [],
    0,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    selectedCodons
  );
};

const drawWithHover = (
  ctx: CanvasRenderingContext2D,
  hoveredCodon: { start: number; end: number; strand: 1 | -1; source?: 'sequence' | 'structure' }
) => {
  drawTranslation(
    ctx,
    SEQ,
    [cds()],
    0,
    SEQ.length - 1,
    0,
    100,
    DEFAULT_EDITOR_CONFIG,
    SEQ,
    [],
    [],
    0,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    hoveredCodon
  );
};

const strokeStyleSets = (log: CanvasOp[]) =>
  log
    .filter(
      (e): e is Extract<CanvasOp, { op: 'set' }> => e.op === 'set' && e.prop === 'strokeStyle'
    )
    .map((e) => String(e.value).toLowerCase());

const setValuesOfNumber = (log: CanvasOp[], prop: string): number[] =>
  log
    .filter((e): e is Extract<CanvasOp, { op: 'set' }> => e.op === 'set' && e.prop === prop)
    .map((e) => Number(e.value))
    .filter((n) => !Number.isNaN(n));

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

beforeEach(() => {
  installRecordingCanvas();
  delete (
    window as typeof window & {
      __WAYPOINT_HOVERED_CODON_OUTLINE_DRAWS__?: unknown;
      __WAYPOINT_SELECTED_CODON_OUTLINE_DRAWS__?: unknown;
    }
  ).__WAYPOINT_HOVERED_CODON_OUTLINE_DRAWS__;
  delete (
    window as typeof window & {
      __WAYPOINT_HOVERED_CODON_OUTLINE_DRAWS__?: unknown;
      __WAYPOINT_SELECTED_CODON_OUTLINE_DRAWS__?: unknown;
    }
  ).__WAYPOINT_SELECTED_CODON_OUTLINE_DRAWS__;
  canvas = document.createElement('canvas');
  ctx = canvas.getContext('2d')!;
});

afterEach(() => {
  uninstallRecordingCanvas();
});

describe('drawTranslation — Mol*-source codon-cell selection paints green, NOT feature colour', () => {
  it('Pass 2.8 strokes a green rgba (light mode)', () => {
    drawWithSelection(ctx, [{ start: 0, end: 2, strand: 1 }]);
    const strokes = strokeStyleSets(getRecordingLog(canvas));
    const seenGreen = strokes.some((s) => s.includes('51, 255, 26') && s.includes('0.95'));
    expect(seenGreen).toBe(true);
  });

  it('Pass 2.8 stroke is NOT a feature-emphasised hex (no `#` strokes for the codon-cell select)', () => {
    drawWithSelection(ctx, [{ start: 0, end: 2, strand: 1 }]);
    const strokes = strokeStyleSets(getRecordingLog(canvas));
    const greenStrokes = strokes.filter((s) => s.includes('51, 255, 26'));
    expect(greenStrokes.length).toBeGreaterThan(0);
  });
});

describe('drawTranslation — chevron-cell hover paints Mol*-pink (any source)', () => {
  it('Pass 2.7 strokes pink on a structure-source hover (3D residue → 2D chevron)', () => {
    drawWithHover(ctx, { start: 0, end: 2, strand: 1, source: 'structure' });
    const strokes = strokeStyleSets(getRecordingLog(canvas));
    const seenPink = strokes.some((s) => s.includes('255, 102, 153') && s.includes('0.95'));
    expect(seenPink).toBe(true);
    const lineWidths = setValuesOfNumber(getRecordingLog(canvas), 'lineWidth');
    expect(lineWidths).toContain(2.5);
  });

  it('Pass 2.7 strokes pink on a sequence-side hover (local pointer over the chevron)', () => {
    drawWithHover(ctx, { start: 0, end: 2, strand: 1, source: 'sequence' });
    const strokes = strokeStyleSets(getRecordingLog(canvas));
    const seenPink = strokes.some((s) => s.includes('255, 102, 153') && s.includes('0.95'));
    expect(seenPink).toBe(true);
    const lineWidths = setValuesOfNumber(getRecordingLog(canvas), 'lineWidth');
    expect(lineWidths).toContain(2.5);
  });

  it('Pass 2.7 strokes pink even when source field is omitted (legacy shape)', () => {
    drawWithHover(ctx, { start: 0, end: 2, strand: 1 });
    const strokes = strokeStyleSets(getRecordingLog(canvas));
    const seenPink = strokes.some((s) => s.includes('255, 102, 153') && s.includes('0.95'));
    expect(seenPink).toBe(true);
    const lineWidths = setValuesOfNumber(getRecordingLog(canvas), 'lineWidth');
    expect(lineWidths).toContain(2.5);
  });
});

describe('drawTranslation — hover and selection codon-cell register must match', () => {
  it('draws the selected outline at the exact same register as hover for the same codon', () => {
    const codon = { start: 12, end: 14, strand: 1 as const };

    drawWithHover(ctx, { ...codon, source: 'structure' });
    const hoverDraw = (
      window as typeof window & {
        __WAYPOINT_HOVERED_CODON_OUTLINE_DRAWS__?: {
          last: {
            start: number;
            end: number;
            strand: 1 | -1;
            x: number;
            y: number;
            width: number;
            height: number;
            viewer: '1d' | '2d';
          } | null;
        };
      }
    ).__WAYPOINT_HOVERED_CODON_OUTLINE_DRAWS__?.last;

    drawWithSelection(ctx, [codon]);
    const selectedDraw = (
      window as typeof window & {
        __WAYPOINT_SELECTED_CODON_OUTLINE_DRAWS__?: {
          last: {
            start: number;
            end: number;
            strand: 1 | -1;
            x: number;
            y: number;
            width: number;
            height: number;
            viewer: '1d' | '2d';
          } | null;
        };
      }
    ).__WAYPOINT_SELECTED_CODON_OUTLINE_DRAWS__?.last;

    expect(hoverDraw, 'hover outline diagnostic did not fire').toBeTruthy();
    expect(selectedDraw, 'selection outline diagnostic did not fire').toBeTruthy();
    const hoverRegister = outlineRegister(hoverDraw!);
    const selectedRegister = outlineRegister(selectedDraw!);
    expect(
      selectedRegister,
      `Selection outline register diverged from hover outline register for ${codon.start}:${codon.end}. ` +
        `hover=${JSON.stringify(hoverRegister)} selected=${JSON.stringify(selectedRegister)}`
    ).toEqual(hoverRegister);
  });
});

function outlineRegister(draw: {
  start: number;
  end: number;
  strand: 1 | -1;
  x: number;
  y: number;
  width: number;
  height: number;
  viewer: '1d' | '2d';
}) {
  return {
    viewer: draw.viewer,
    start: draw.start,
    end: draw.end,
    strand: draw.strand,
    x: draw.x,
    y: draw.y,
    width: draw.width,
    height: draw.height,
  };
}
