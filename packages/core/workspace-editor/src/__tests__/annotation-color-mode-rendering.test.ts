// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AnnotationColorMode } from '@waypoint/sequence-utils';
import { drawAnnotations } from '../canvas-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
  type CanvasOp,
} from '../testing/recording-canvas-context';
import type { Annotation } from '../types';

const manualColor = '#111111';
const promoterTypeColor = '#22C55E';

const promoter = (): Annotation & { lane: number } => ({
  type: 'promoter',
  name: 'manual colored promoter',
  start: 1,
  end: 80,
  direction: 1,
  color: manualColor,
  lane: 0,
});

const drawWithMode = (ctx: CanvasRenderingContext2D, colorMode: AnnotationColorMode) => {
  drawAnnotations(
    ctx,
    [promoter()],
    0,
    160,
    0,
    100,
    1,
    { ...DEFAULT_EDITOR_CONFIG, annotationColorMode: colorMode },
    160,
    undefined,
    undefined,
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

describe('drawAnnotations — annotation color modes', () => {
  it('auto-type renders the feature-type color and ignores legacy annotation.color', () => {
    drawWithMode(ctx, 'auto-type');

    const fillStyles = setValuesOf(getRecordingLog(canvas), 'fillStyle');
    expect(fillStyles).toContain(promoterTypeColor);
    expect(fillStyles).not.toContain(manualColor);
  });

  it('manual renders the saved annotation color', () => {
    drawWithMode(ctx, 'manual');

    const fillStyles = setValuesOf(getRecordingLog(canvas), 'fillStyle');
    expect(fillStyles).toContain(manualColor);
  });
});
