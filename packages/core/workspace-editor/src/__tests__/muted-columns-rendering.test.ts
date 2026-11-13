/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Annotation } from '@waypoint/sequence-utils';
import { drawAnnotationSegment } from '../canvas-drawing';
import { drawTranslation } from '../translation-drawing';
import { drawTranslationLabels1D } from '../translation-labels-1d';
import { DEFAULT_EDITOR_CONFIG, type ClassifiedCDS } from '../types';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
  type CanvasOp,
} from '../testing/recording-canvas-context';

const MUTED = '#9ca3af';

function setValuesOf(log: CanvasOp[], prop: string): unknown[] {
  return log
    .filter((e): e is Extract<CanvasOp, { op: 'set' }> => e.op === 'set' && e.prop === prop)
    .map((e) => e.value);
}

function fillStyleAt(log: CanvasOp[], index: number): unknown {
  for (let i = index; i >= 0; i--) {
    const op = log[i];
    if (op?.op === 'set' && op.prop === 'fillStyle') return op.value;
  }
  return undefined;
}

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

beforeEach(() => {
  installRecordingCanvas();
  canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('recording canvas context unavailable');
  ctx = context;
});

afterEach(() => {
  uninstallRecordingCanvas();
});

describe('muted column rendering', () => {
  it('grays annotation bar segments over muted columns without adding internal tear markers', () => {
    const ann: Annotation & { lane: number } = {
      type: 'gene',
      name: 'feature',
      start: 1,
      end: 18,
      direction: 1,
      color: '#22c55e',
      lane: 0,
    };

    drawAnnotationSegment(
      ctx,
      ann,
      0,
      18,
      0,
      0,
      20,
      DEFAULT_EDITOR_CONFIG,
      16,
      20,
      true,
      true,
      true,
      undefined,
      undefined,
      'default',
      false,
      {
        mutedColumns: new Set([6, 7, 8, 9, 10, 11]),
        mutedColumnColor: MUTED,
        sequenceLength: 18,
      }
    );

    const log = getRecordingLog(canvas);
    expect(setValuesOf(log, 'fillStyle')).toContain(MUTED);
    expect(log.some((op) => op.op === 'fillText' && ['»', '«', '…'].includes(op.text))).toBe(false);
  });

  it('fades and desaturates an entire CDS codon when any nucleotide in that codon is muted', () => {
    const sequence = 'ATGAAATTT';
    const cds = {
      type: 'CDS',
      name: 'orf1',
      start: 1,
      end: 9,
      direction: 1,
      color: '#22c55e',
      translationLane: 0,
    } as ClassifiedCDS;

    drawTranslation(
      ctx,
      sequence,
      [cds],
      0,
      sequence.length,
      0,
      0,
      { ...DEFAULT_EDITOR_CONFIG, aaColorScheme: 'none' },
      sequence,
      [],
      [],
      0,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      {
        mutedColumns: new Set([2]),
        mutedColumnColor: MUTED,
      }
    );

    const log = getRecordingLog(canvas);
    const fillStyles = setValuesOf(log, 'fillStyle');
    expect(fillStyles).not.toContain(MUTED);
    expect(fillStyles.some((value) => typeof value === 'string' && value.startsWith('rgb('))).toBe(
      true
    );

    const mutedAaTextIndex = log.findIndex((op) => op.op === 'fillText' && op.text === 'M');
    expect(mutedAaTextIndex).toBeGreaterThanOrEqual(0);
    expect(fillStyleAt(log, mutedAaTextIndex)).toMatch(/^rgba\(.+, 0\.42\)$/);
  });

  it('grays the 1D CDS label strip over muted source columns', () => {
    const cds = {
      type: 'CDS',
      name: 'orf1',
      start: 1,
      end: 9,
      direction: 1,
      color: '#22c55e',
      translationLane: 0,
    } as ClassifiedCDS;

    drawTranslationLabels1D(ctx, {
      cdss: [cds],
      pxPerBase: 10,
      columnCount: 9,
      sequenceLength: 9,
      viewportLeftX: 0,
      viewportRightX: 90,
      originX: 0,
      bandTopY: 0,
      laneHeight: 40,
      labelFontSize: 10,
      labelFontFamily: 'sans-serif',
      mutedColumns: new Set([3, 4]),
      mutedColumnColor: MUTED,
    });

    expect(setValuesOf(getRecordingLog(canvas), 'fillStyle')).toContain(MUTED);
  });
});
