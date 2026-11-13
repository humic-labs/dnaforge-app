// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawTranslation } from '../translation-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import { setCanvasTheme, type CanvasTheme } from '../canvas-theme';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  type CanvasOp,
} from '../testing/recording-canvas-context';
import type { ClassifiedCDS } from '../types';

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

type HoveredCodonArg = Parameters<typeof drawTranslation>[18] | undefined;
type AnnotationStateArg = 'hovered' | 'selected' | undefined;

const lightTheme: CanvasTheme = {
  isDark: false,
  bg: '#ffffff',
  bgSubtle: '#f5f5f5',
  bgMuted: '#f3f4f6',
  fg: '#000000',
  fgMuted: '#888888',
  fgSubtle: '#999999',
  border: '#cccccc',
  accent: '#1976d2',
  error: '#DC2626',
};

const darkTheme: CanvasTheme = {
  ...lightTheme,
  isDark: true,
};

const drawWith = (
  ctx: CanvasRenderingContext2D,
  hoveredCodon: HoveredCodonArg = null,
  cdsOverride: Partial<ClassifiedCDS> = {},
  annotationState?: AnnotationStateArg
) => {
  const target = cds(cdsOverride);
  drawTranslation(
    ctx,
    SEQ,
    [target],
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
    annotationState
      ? {
          hovered: annotationState === 'hovered' ? target : null,
          selected: annotationState === 'selected' ? target : null,
        }
      : undefined,
    undefined,
    hoveredCodon
  );
};

const fillTextOps = (log: CanvasOp[]) =>
  log.filter((e): e is Extract<CanvasOp, { op: 'fillText' }> => e.op === 'fillText');

const dashOps = (log: CanvasOp[]) =>
  log.filter((e): e is Extract<CanvasOp, { op: 'setLineDash' }> => e.op === 'setLineDash');

const setValuesOf = (log: CanvasOp[], prop: string): unknown[] =>
  log.filter((e) => e.op === 'set' && e.prop === prop).map((e) => e.value);

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

beforeEach(() => {
  setCanvasTheme(lightTheme);
  installRecordingCanvas();
  canvas = document.createElement('canvas');
  ctx = canvas.getContext('2d')!;
});

afterEach(() => {
  uninstallRecordingCanvas();
  setCanvasTheme(lightTheme);
});

describe('drawTranslation — cross-surface hover/select must not blank the canvas', () => {
  it('renders AA letters when hoveredCodon is null (baseline)', () => {
    expect(() => drawWith(ctx, null)).not.toThrow();
    const log = getRecordingLog(canvas);
    expect(fillTextOps(log).length).toBeGreaterThan(0);
  });

  it('renders AA letters when hoveredCodon has no source (sequence-side hover, legacy shape)', () => {
    const hovered = { start: 0, end: 2, strand: 1 as const };
    expect(() => drawWith(ctx, hovered)).not.toThrow();
    const log = getRecordingLog(canvas);
    expect(fillTextOps(log).length).toBeGreaterThan(0);
  });

  it('renders AA letters when hoveredCodon comes from sequence side (source: sequence)', () => {
    const hovered = { start: 0, end: 2, strand: 1 as const, source: 'sequence' as const };
    expect(() => drawWith(ctx, hovered)).not.toThrow();
    const log = getRecordingLog(canvas);
    expect(fillTextOps(log).length).toBeGreaterThan(0);
  });

  it('renders AA letters when hoveredCodon comes from 3D structure (source: structure) — REGRESSION GATE', () => {
    const hovered = { start: 0, end: 2, strand: 1 as const, source: 'structure' as const };
    expect(() => drawWith(ctx, hovered)).not.toThrow();
    const log = getRecordingLog(canvas);
    expect(fillTextOps(log).length).toBeGreaterThan(0);
  });

  it('renders AA letters when structure-source hover targets a codon in the middle of the CDS', () => {
    const hovered = { start: 12, end: 14, strand: 1 as const, source: 'structure' as const };
    expect(() => drawWith(ctx, hovered)).not.toThrow();
    const log = getRecordingLog(canvas);
    expect(fillTextOps(log).length).toBeGreaterThan(0);
  });

  it('renders AA letters when structure-source hover targets a codon outside this CDS (no match)', () => {
    const hovered = { start: 100, end: 102, strand: 1 as const, source: 'structure' as const };
    expect(() => drawWith(ctx, hovered)).not.toThrow();
    const log = getRecordingLog(canvas);
    expect(fillTextOps(log).length).toBeGreaterThan(0);
  });

  it('renders AA letters when structure-source hover has the wrong strand (reverse)', () => {
    const hovered = { start: 0, end: 2, strand: -1 as const, source: 'structure' as const };
    expect(() => drawWith(ctx, hovered)).not.toThrow();
    const log = getRecordingLog(canvas);
    expect(fillTextOps(log).length).toBeGreaterThan(0);
  });
});

describe('drawTranslation — draft CDS outlines', () => {
  it('uses a lighter neutral gray for ordinary AA chevron cell borders in light mode, not CDS blue', () => {
    drawWith(ctx, null, { color: '#3b82f6' });
    const strokeStyles = setValuesOf(getRecordingLog(canvas), 'strokeStyle');

    expect(strokeStyles).toContain('rgba(156, 163, 175, 0.38)');
    expect(strokeStyles).not.toContain('#3b82f6');
  });

  it('uses a darker neutral gray for ordinary AA chevron cell borders in dark mode', () => {
    setCanvasTheme(darkTheme);
    drawWith(ctx, null, { color: '#3b82f6' });
    const strokeStyles = setValuesOf(getRecordingLog(canvas), 'strokeStyle');

    expect(strokeStyles).toContain('rgba(156, 163, 175, 0.3)');
    expect(strokeStyles).not.toContain('#3b82f6');
  });

  it('draws a dotted outline around accepted pLannotate CDS chevrons', () => {
    drawWith(ctx, null, { qualifiers: { source: ['pLannotate-draft'], status: ['accepted'] } });

    expect(dashOps(getRecordingLog(canvas)).some((op) => op.segments.join(',') === '2,2')).toBe(
      true
    );
  });

  it('draws a dotted outline around authored CDS draft chevrons without making them hollow', () => {
    drawWith(ctx, null, { qualifiers: { source: ['annotation-draft'] } });
    const log = getRecordingLog(canvas);

    expect(fillTextOps(log).length).toBeGreaterThan(0);
    expect(setValuesOf(log, 'globalAlpha')).toContain(0.3);
    expect(setValuesOf(log, 'globalAlpha')).not.toContain(0.18);
    expect(dashOps(log).some((op) => op.segments.join(',') === '2,2')).toBe(true);
  });

  it('does not layer the selected outline over authored CDS draft chevrons', () => {
    drawWith(ctx, null, { qualifiers: { source: ['annotation-draft'] } }, 'selected');
    const log = getRecordingLog(canvas);

    expect(dashOps(log).some((op) => op.segments.join(',') === '2,2')).toBe(true);
    expect(setValuesOf(log, 'lineWidth')).not.toContain(2.5);
  });
});
